import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FlowStep } from "../agents/types";
import type { RepoTask } from "./tasks";

export const STATE_DIRECTORY = join(homedir(), ".multiagents");
export const STATE_DATABASE = join(STATE_DIRECTORY, "state.db");
export const SCHEMA_VERSION = 2;
const MAX_STORED_PROMPT_CHARS = 20_000;
const MAX_STORED_OUTPUT_CHARS = 1_000_000;

export const taskEventTypes = [
  "task_created", "flow_started", "step_started", "step_completed", "step_failed", "step_rerun", "step_stale",
  "flow_completed", "flow_aborted", "approval_issued", "approval_invalidated", "approval_accepted", "approval_failed",
  "validation_started", "validation_passed", "validation_failed", "diff_generated", "commit_created", "branch_pushed",
  "pr_created", "pr_review_fetched", "rework_started", "rework_completed", "ready_for_human_merge", "task_archived",
] as const;
export type TaskEventType = (typeof taskEventTypes)[number];
export type TaskEventActor = "user" | "system" | "codex" | "cursor" | "claude";
export type TaskEventMetadata = Partial<{
  durationMs: number;
  diffHash: string;
  commitSha: string;
  prNumber: number;
  changedFileCount: number;
  additions: number;
  deletions: number;
}>;
export type TaskEvent = {
  id: string;
  sequence: number;
  taskId: string;
  type: TaskEventType;
  createdAt: string;
  actor: TaskEventActor;
  stepId?: string;
  status?: string;
  metadata?: TaskEventMetadata;
};
export type StepVersion = {
  id: string;
  taskId: string;
  stepId: FlowStep["id"];
  version: number;
  agent: FlowStep["agent"];
  createdAt: string;
  output: string;
  status: FlowStep["status"];
  durationMs?: number;
};
export type DiffVersion = {
  id: string;
  taskId: string;
  version: number;
  diffHash: string;
  changedFileCount: number;
  additions: number;
  deletions: number;
  createdAt: string;
};
export type ApprovalEvent = {
  id: string;
  sequence: number;
  taskId: string;
  approvalId: string;
  type: "issued" | "invalidated" | "accepted" | "failed";
  purpose: "create_pr" | "rework";
  diffHash: string;
  createdAt: string;
  status?: string;
};
export type TaskHistory = { events: TaskEvent[]; stepVersions: StepVersion[]; diffVersions: DiffVersion[]; approvalEvents: ApprovalEvent[] };

type TaskRow = Record<string, unknown>;
type FlowStepRow = Record<string, unknown>;

export class StateStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private transactionDepth = 0;

  constructor(path = STATE_DATABASE) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close() { this.database.close(); }

  schemaVersion() {
    const row = this.database.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null };
    return row.version ?? 0;
  }

  saveTask(task: RepoTask) {
    const now = new Date().toISOString();
    task.createdAt ||= now;
    task.updatedAt = now;
    const review = task.prReview;
    const reviewDisposition = task.reviewIntake?.readyForHumanMerge ? "ready" : task.reviewIntake?.requiresRework ? "action_required" : undefined;
    const ciStatus = task.status === "ci_failed" ? "fail" : task.status === "ci_pending" ? "pending" : task.status === "ready_for_human_merge" ? "pass" : undefined;
    const payload = {
      reviewReady: task.reviewReady,
      validation: task.validation,
      secretFindings: task.secretFindings,
      prReview: review ? {
        ...review,
        // GitHub bodies are externally recoverable. Keep only bounded metadata needed by Resume.
        items: review.items.slice(0, 200).map((item) => ({ ...item, body: "" })),
      } : undefined,
      reviewIntake: task.reviewIntake,
      reworkResult: task.reworkResult,
      originalTaskAvailable: task.originalTaskAvailable,
      reworkBaseSha: task.reworkBaseSha,
      latestPushedSha: task.latestPushedSha,
      ciMessage: task.ciMessage,
      error: task.error,
    };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO tasks (
          task_id, repo_id, repo_name, repo_path, allowed_root, base_branch, task_branch,
          base_sha, origin_url, worktree_path, worktree_root, worktree_available, worktree_status,
          status, original_prompt, created_at, updated_at, flow_id, flow_status, final_output,
          diff_hash, approval_state, approval_purpose, approval_id, commit_sha, pr_number, pr_url,
          pr_head_sha, review_disposition, unresolved_count, ci_status, merge_readiness,
          recovery_status, recovery_message, payload_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(task_id) DO UPDATE SET
          repo_id=excluded.repo_id, repo_name=excluded.repo_name, repo_path=excluded.repo_path,
          allowed_root=excluded.allowed_root, base_branch=excluded.base_branch, task_branch=excluded.task_branch,
          base_sha=excluded.base_sha, origin_url=excluded.origin_url, worktree_path=excluded.worktree_path,
          worktree_root=excluded.worktree_root, worktree_available=excluded.worktree_available,
          worktree_status=excluded.worktree_status, status=excluded.status,
          original_prompt=excluded.original_prompt, updated_at=excluded.updated_at,
          flow_id=excluded.flow_id, flow_status=excluded.flow_status, final_output=excluded.final_output,
          diff_hash=excluded.diff_hash, approval_state=excluded.approval_state,
          approval_purpose=excluded.approval_purpose, approval_id=excluded.approval_id,
          commit_sha=excluded.commit_sha, pr_number=excluded.pr_number, pr_url=excluded.pr_url,
          pr_head_sha=excluded.pr_head_sha, review_disposition=excluded.review_disposition,
          unresolved_count=excluded.unresolved_count, ci_status=excluded.ci_status,
          merge_readiness=excluded.merge_readiness, recovery_status=excluded.recovery_status,
          recovery_message=excluded.recovery_message, payload_json=excluded.payload_json
      `).run(
        task.id, task.repoId, task.repoName, task.repoPath, task.allowedRoot, task.baseBranch, task.branch,
        task.baseSha, task.originUrl ?? null, task.worktreePath, task.worktreeRoot,
        task.worktreeAvailable ? 1 : 0, task.worktreeStatus, task.status,
        bounded(task.prompt, MAX_STORED_PROMPT_CHARS), task.createdAt, task.updatedAt,
        task.flowId ?? null, task.flowStatus ?? null, bounded(task.finalOutput ?? "", MAX_STORED_OUTPUT_CHARS),
        task.diffHash ?? null, task.approvalState, task.approvalPurpose ?? null, task.approvalId ?? null,
        task.commitSha ?? null, task.prNumber ?? null, task.prUrl ?? null,
        review?.headSha ?? task.latestPushedSha ?? task.commitSha ?? null,
        reviewDisposition ?? null, review?.unresolvedCount ?? null, ciStatus ?? null,
        task.status === "ready_for_human_merge" ? "ready_for_human_merge" : null,
        task.recoveryStatus, task.recoveryMessage ?? null, JSON.stringify(payload),
      );
      this.replaceFlowSteps(task.id, task.flowSteps ?? []);
    });
  }

  loadTasks(): RepoTask[] {
    const rows = this.database.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as TaskRow[];
    const stepStatement = this.database.prepare("SELECT * FROM flow_steps WHERE task_id = ? ORDER BY ordinal");
    return rows.map((row) => this.rowToTask(row, stepStatement.all(String(row.task_id)) as FlowStepRow[]));
  }

  clearForTests() {
    this.transaction(() => {
      this.dropAppendOnlyTriggers();
      this.database.exec("DELETE FROM approval_events; DELETE FROM diff_versions; DELETE FROM step_versions; DELETE FROM task_events; DELETE FROM flow_steps; DELETE FROM tasks;");
      this.createAppendOnlyTriggers();
    });
  }

  appendTaskEvent(taskId: string, input: { type: TaskEventType; actor: TaskEventActor; createdAt?: string; stepId?: string; status?: string; metadata?: TaskEventMetadata }) {
    if (!taskEventTypes.includes(input.type)) throw new Error("Task event type is invalid");
    if (!["user", "system", "codex", "cursor", "claude"].includes(input.actor)) throw new Error("Task event actor is invalid");
    const metadata = validateMetadata(input.metadata);
    if (input.status && !/^[a-z0-9_-]{1,100}$/i.test(input.status)) throw new Error("Task event status is invalid");
    if (input.stepId && !/^[a-z0-9_-]{1,100}$/i.test(input.stepId)) throw new Error("Task event stepId is invalid");
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO task_events (event_id, task_id, event_type, created_at, actor, step_id, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, input.type, createdAt, input.actor, input.stepId ?? null, input.status ?? null, metadata ? JSON.stringify(metadata) : null);
    return { id, sequence: Number(result.lastInsertRowid), taskId, type: input.type, createdAt, actor: input.actor, stepId: input.stepId, status: input.status, metadata } satisfies TaskEvent;
  }

  appendStepVersion(taskId: string, step: FlowStep, createdAt = new Date().toISOString()) {
    const version = Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM step_versions WHERE task_id = ? AND step_id = ?").get(taskId, step.id) as { version: number }).version);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO step_versions (version_id, task_id, step_id, version, agent, created_at, output, status, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, step.id, version, step.agent, createdAt, bounded(step.output, MAX_STORED_OUTPUT_CHARS), step.status, step.durationMs ?? null);
    return { id, taskId, stepId: step.id, version, agent: step.agent, createdAt, output: bounded(step.output, MAX_STORED_OUTPUT_CHARS), status: step.status, durationMs: step.durationMs } satisfies StepVersion;
  }

  appendDiffVersion(taskId: string, input: Omit<DiffVersion, "id" | "taskId" | "version" | "createdAt"> & { createdAt?: string }) {
    const existing = this.database.prepare("SELECT version_id FROM diff_versions WHERE task_id = ? AND diff_hash = ?").get(taskId, input.diffHash);
    if (existing) return undefined;
    const version = Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM diff_versions WHERE task_id = ?").get(taskId) as { version: number }).version);
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.database.prepare(`
      INSERT INTO diff_versions (version_id, task_id, version, diff_hash, changed_file_count, additions, deletions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, version, input.diffHash, nonnegativeInteger(input.changedFileCount), nonnegativeInteger(input.additions), nonnegativeInteger(input.deletions), createdAt);
    return { id, taskId, version, diffHash: input.diffHash, changedFileCount: input.changedFileCount, additions: input.additions, deletions: input.deletions, createdAt } satisfies DiffVersion;
  }

  appendApprovalEvent(taskId: string, input: Omit<ApprovalEvent, "id" | "sequence" | "taskId" | "createdAt"> & { createdAt?: string }) {
    if (!/^[0-9a-f-]{36}$/i.test(input.approvalId)) throw new Error("Approval history ID is invalid");
    if (!/^[0-9a-f]{64}$/i.test(input.diffHash)) throw new Error("Approval history diff hash is invalid");
    if (input.status && !/^[a-z0-9_-]{1,100}$/i.test(input.status)) throw new Error("Approval history status is invalid");
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO approval_events (approval_event_id, task_id, approval_id, event_type, purpose, diff_hash, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, input.approvalId, input.type, input.purpose, input.diffHash, createdAt, input.status ?? null);
    return { id, sequence: Number(result.lastInsertRowid), taskId, approvalId: input.approvalId, type: input.type, purpose: input.purpose, diffHash: input.diffHash, createdAt, status: input.status } satisfies ApprovalEvent;
  }

  loadTaskHistory(taskId: string): TaskHistory {
    const events = (this.database.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence ASC").all(taskId) as TaskRow[]).map(rowToTaskEvent);
    const stepVersions = (this.database.prepare("SELECT * FROM step_versions WHERE task_id = ? ORDER BY step_id, version ASC").all(taskId) as TaskRow[]).map(rowToStepVersion);
    const diffVersions = (this.database.prepare("SELECT * FROM diff_versions WHERE task_id = ? ORDER BY version ASC").all(taskId) as TaskRow[]).map(rowToDiffVersion);
    const approvalEvents = (this.database.prepare("SELECT * FROM approval_events WHERE task_id = ? ORDER BY sequence ASC").all(taskId) as TaskRow[]).map(rowToApprovalEvent);
    return { events, stepVersions, diffVersions, approvalEvents };
  }

  /** Exposed for rollback tests; application writes use saveTask(). */
  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private replaceFlowSteps(taskId: string, steps: FlowStep[]) {
    this.database.prepare("DELETE FROM flow_steps WHERE task_id = ?").run(taskId);
    const insert = this.database.prepare(`
      INSERT INTO flow_steps (
        task_id, step_id, ordinal, agent, role, status, output, error,
        duration_ms, started_at, completed_at, stale_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    steps.forEach((step, ordinal) => insert.run(
      taskId, step.id, ordinal, step.agent, step.role, step.status,
      bounded(step.output, MAX_STORED_OUTPUT_CHARS), step.error ?? null,
      step.durationMs ?? null, step.startedAt ?? null, step.completedAt ?? null,
      step.status === "stale" ? step.error ?? null : null,
    ));
  }

  private rowToTask(row: TaskRow, steps: FlowStepRow[]): RepoTask {
    const payload = parseObject(row.payload_json);
    return {
      id: String(row.task_id), repoId: String(row.repo_id), repoName: String(row.repo_name),
      repoPath: String(row.repo_path), allowedRoot: String(row.allowed_root), branch: String(row.task_branch),
      baseBranch: String(row.base_branch), baseSha: String(row.base_sha), originUrl: optionalString(row.origin_url),
      worktreePath: String(row.worktree_path), worktreeRoot: String(row.worktree_root),
      worktreeAvailable: Number(row.worktree_available) === 1,
      worktreeStatus: String(row.worktree_status) as RepoTask["worktreeStatus"],
      status: String(row.status) as RepoTask["status"], prompt: String(row.original_prompt),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      flowId: optionalString(row.flow_id), flowStatus: optionalString(row.flow_status),
      finalOutput: optionalString(row.final_output), flowSteps: steps.map(rowToFlowStep),
      reviewReady: payload.reviewReady === true, diffHash: optionalString(row.diff_hash),
      approvalState: String(row.approval_state) as RepoTask["approvalState"],
      approvalPurpose: optionalString(row.approval_purpose) as RepoTask["approvalPurpose"],
      approvalId: optionalString(row.approval_id), validation: array(payload.validation),
      secretFindings: array(payload.secretFindings), commitSha: optionalString(row.commit_sha),
      prNumber: optionalNumber(row.pr_number), prUrl: optionalString(row.pr_url),
      prReview: objectOrUndefined(payload.prReview), reviewIntake: objectOrUndefined(payload.reviewIntake),
      reworkResult: objectOrUndefined(payload.reworkResult),
      originalTaskAvailable: payload.originalTaskAvailable === true,
      reworkBaseSha: optionalString(payload.reworkBaseSha), latestPushedSha: optionalString(payload.latestPushedSha),
      ciMessage: optionalString(payload.ciMessage), error: optionalString(payload.error),
      recoveryStatus: String(row.recovery_status) as RepoTask["recoveryStatus"],
      recoveryMessage: optionalString(row.recovery_message),
    } as RepoTask;
  }

  private migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    let version = this.schemaVersion();
    if (version > SCHEMA_VERSION) throw new Error(`State database schema ${version} is newer than supported version ${SCHEMA_VERSION}`);
    if (version < 1) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, repo_name TEXT NOT NULL, repo_path TEXT NOT NULL,
          allowed_root TEXT NOT NULL, base_branch TEXT NOT NULL, task_branch TEXT NOT NULL,
          base_sha TEXT NOT NULL, origin_url TEXT, worktree_path TEXT NOT NULL, worktree_root TEXT NOT NULL,
          worktree_available INTEGER NOT NULL, worktree_status TEXT NOT NULL, status TEXT NOT NULL,
          original_prompt TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          flow_id TEXT, flow_status TEXT, final_output TEXT, diff_hash TEXT,
          approval_state TEXT NOT NULL, approval_purpose TEXT, approval_id TEXT,
          commit_sha TEXT, pr_number INTEGER, pr_url TEXT, pr_head_sha TEXT,
          review_disposition TEXT, unresolved_count INTEGER, ci_status TEXT, merge_readiness TEXT,
          recovery_status TEXT NOT NULL, recovery_message TEXT, payload_json TEXT NOT NULL
        );
        CREATE TABLE flow_steps (
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          step_id TEXT NOT NULL, ordinal INTEGER NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL,
          status TEXT NOT NULL, output TEXT NOT NULL, error TEXT, duration_ms INTEGER,
          started_at TEXT, completed_at TEXT, stale_reason TEXT,
          PRIMARY KEY (task_id, step_id)
        );
        CREATE INDEX tasks_updated_at_idx ON tasks(updated_at DESC);
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
    });
    if (version < 1) version = 1;
    if (version < 2) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE task_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          event_type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          actor TEXT NOT NULL,
          step_id TEXT,
          status TEXT,
          metadata_json TEXT
        );
        CREATE INDEX task_events_task_order_idx ON task_events(task_id, sequence);
        CREATE TABLE step_versions (
          version_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          step_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          agent TEXT NOT NULL,
          created_at TEXT NOT NULL,
          output TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_ms INTEGER,
          UNIQUE(task_id, step_id, version)
        );
        CREATE INDEX step_versions_task_idx ON step_versions(task_id, step_id, version);
        CREATE TABLE diff_versions (
          version_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          version INTEGER NOT NULL CHECK(version > 0),
          diff_hash TEXT NOT NULL,
          changed_file_count INTEGER NOT NULL CHECK(changed_file_count >= 0),
          additions INTEGER NOT NULL CHECK(additions >= 0),
          deletions INTEGER NOT NULL CHECK(deletions >= 0),
          created_at TEXT NOT NULL,
          UNIQUE(task_id, version),
          UNIQUE(task_id, diff_hash)
        );
        CREATE TABLE approval_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          approval_event_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          approval_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('issued', 'invalidated', 'accepted', 'failed')),
          purpose TEXT NOT NULL CHECK(purpose IN ('create_pr', 'rework')),
          diff_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT
        );
        CREATE INDEX approval_events_task_order_idx ON approval_events(task_id, sequence);
        INSERT INTO task_events (event_id, task_id, event_type, created_at, actor, status, metadata_json)
          SELECT lower(hex(randomblob(16))), task_id, 'task_created', created_at, 'system', status, NULL FROM tasks;
      `);
      this.createAppendOnlyTriggers();
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(2, new Date().toISOString());
    });
  }

  private createAppendOnlyTriggers() {
    for (const table of ["task_events", "step_versions", "diff_versions", "approval_events"]) {
      this.database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      `);
    }
  }

  private dropAppendOnlyTriggers() {
    for (const table of ["task_events", "step_versions", "diff_versions", "approval_events"]) {
      this.database.exec(`DROP TRIGGER IF EXISTS ${table}_no_update; DROP TRIGGER IF EXISTS ${table}_no_delete;`);
    }
  }
}

let store: StateStore | undefined;

export function getStateStore() {
  store ??= new StateStore(process.env.NODE_ENV === "test" ? ":memory:" : STATE_DATABASE);
  return store;
}

export function replaceStateStoreForTests(replacement?: StateStore) {
  store?.close();
  store = replacement;
}

function bounded(value: string, limit: number) { return value.length <= limit ? value : value.slice(0, limit); }
function optionalString(value: unknown) { return typeof value === "string" && value.length ? value : undefined; }
function optionalNumber(value: unknown) { return typeof value === "number" ? value : value === null || value === undefined ? undefined : Number(value); }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function objectOrUndefined(value: unknown) { return value && typeof value === "object" ? value : undefined; }
function parseObject(value: unknown): Record<string, unknown> {
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" ? parsed : {}; }
  catch { return {}; }
}
const metadataKeys = new Set(["durationMs", "diffHash", "commitSha", "prNumber", "changedFileCount", "additions", "deletions"]);
function validateMetadata(value: TaskEventMetadata | undefined) {
  if (!value) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (!metadataKeys.has(key)) throw new Error(`Task event metadata key ${JSON.stringify(key)} is forbidden`);
    if (item === undefined) continue;
    if (["durationMs", "changedFileCount", "additions", "deletions"].includes(key) && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "prNumber" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "diffHash" && (typeof item !== "string" || !/^[0-9a-f]{64}$/i.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "commitSha" && (typeof item !== "string" || !/^[0-9a-f]{40,64}$/i.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
  }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as TaskEventMetadata;
}
function nonnegativeInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("History count must be a non-negative integer");
  return value;
}
function rowToTaskEvent(row: TaskRow): TaskEvent {
  const metadata = parseObject(row.metadata_json);
  return { id: String(row.event_id), sequence: Number(row.sequence), taskId: String(row.task_id), type: String(row.event_type) as TaskEventType, createdAt: String(row.created_at), actor: String(row.actor) as TaskEventActor, stepId: optionalString(row.step_id), status: optionalString(row.status), metadata: Object.keys(metadata).length ? metadata as TaskEventMetadata : undefined };
}
function rowToStepVersion(row: TaskRow): StepVersion {
  return { id: String(row.version_id), taskId: String(row.task_id), stepId: String(row.step_id) as FlowStep["id"], version: Number(row.version), agent: String(row.agent) as FlowStep["agent"], createdAt: String(row.created_at), output: String(row.output), status: String(row.status) as FlowStep["status"], durationMs: optionalNumber(row.duration_ms) };
}
function rowToDiffVersion(row: TaskRow): DiffVersion {
  return { id: String(row.version_id), taskId: String(row.task_id), version: Number(row.version), diffHash: String(row.diff_hash), changedFileCount: Number(row.changed_file_count), additions: Number(row.additions), deletions: Number(row.deletions), createdAt: String(row.created_at) };
}
function rowToApprovalEvent(row: TaskRow): ApprovalEvent {
  return { id: String(row.approval_event_id), sequence: Number(row.sequence), taskId: String(row.task_id), approvalId: String(row.approval_id), type: String(row.event_type) as ApprovalEvent["type"], purpose: String(row.purpose) as ApprovalEvent["purpose"], diffHash: String(row.diff_hash), createdAt: String(row.created_at), status: optionalString(row.status) };
}
function rowToFlowStep(row: FlowStepRow): FlowStep {
  return {
    id: String(row.step_id) as FlowStep["id"], agent: String(row.agent) as FlowStep["agent"],
    role: String(row.role) as FlowStep["role"], status: String(row.status) as FlowStep["status"],
    output: String(row.output), error: optionalString(row.error), durationMs: optionalNumber(row.duration_ms),
    startedAt: optionalString(row.started_at), completedAt: optionalString(row.completed_at),
  };
}
