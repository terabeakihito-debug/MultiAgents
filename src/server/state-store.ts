import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FlowStep } from "../agents/types";
import type { DashboardCounts, DashboardSort, PrFilter, TaskBucket } from "../dashboard/types";
import { parseProfileSnapshot, safeDefaultSnapshot, type ProjectProfile, type ProjectProfileSnapshot } from "../profiles/policy";
import type { RepoTask } from "./tasks";

export const STATE_DIRECTORY = join(homedir(), ".multiagents");
export const STATE_DATABASE = join(STATE_DIRECTORY, "state.db");
export const SCHEMA_VERSION = 3;
const MAX_STORED_PROMPT_CHARS = 20_000;
const MAX_STORED_OUTPUT_CHARS = 1_000_000;

export const taskEventTypes = [
  "task_created", "flow_started", "step_started", "step_completed", "step_failed", "step_rerun", "step_stale",
  "flow_completed", "flow_aborted", "approval_issued", "approval_invalidated", "approval_accepted", "approval_failed",
  "validation_started", "validation_passed", "validation_failed", "diff_generated", "commit_created", "branch_pushed",
  "pr_created", "pr_review_fetched", "rework_started", "rework_completed", "ready_for_human_merge", "task_archived",
  "task_resumed", "worktree_cleanup_requested", "worktree_removed", "pr_status_refreshed",
  "profile_snapshot_created",
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
  profileId: string;
  profileVersion: number;
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

export type DashboardQuery = {
  bucket?: TaskBucket;
  repo?: string;
  status?: string;
  pr: PrFilter;
  search?: string;
  sort: DashboardSort;
  includeArchived: boolean;
  limit: number;
};

export type DashboardRow = {
  taskId: string;
  repoId: string;
  repoName: string;
  branch: string;
  baseBranch: string;
  status: string;
  originalPrompt: string;
  createdAt: string;
  updatedAt: string;
  prNumber?: number;
  prUrl?: string;
  recoveryStatus: string;
  recoveryMessage?: string;
  worktreeStatus: string;
  worktreeAvailable: boolean;
  bucket: TaskBucket;
  payload: Record<string, unknown>;
  profileId?: string;
  profileVersion?: number;
};

export type ProfileAuditEventType = "profile_created" | "profile_updated" | "profile_assigned" | "profile_snapshot_created";
export type ProjectProfileVersion = { profileId: string; version: number; changedAt: string; changedFields: string[]; actor: "user"; snapshot: ProjectProfileSnapshot };

const DASHBOARD_BUCKET_SQL = `CASE
  WHEN status = 'archived' OR worktree_status = 'removed' THEN 'archived'
  WHEN merge_readiness = 'ready_for_human_merge'
    AND pr_number IS NOT NULL
    AND recovery_status NOT IN ('orphaned', 'invalid')
    AND worktree_status = 'available'
    AND json_extract(payload_json, '$.prReview.state') = 'OPEN'
    AND COALESCE(json_extract(payload_json, '$.prReview.merged'), 0) = 0
    AND json_array_length(COALESCE(json_extract(payload_json, '$.validation'), '[]')) > 0
    AND NOT EXISTS (SELECT 1 FROM json_each(payload_json, '$.validation') WHERE json_extract(value, '$.status') = 'fail')
    AND NOT EXISTS (SELECT 1 FROM json_each(payload_json, '$.prReview.items') WHERE json_extract(value, '$.disposition') IN ('blocking', 'action_required'))
    AND NOT EXISTS (SELECT 1 FROM json_each(payload_json, '$.prReview.checks') WHERE json_extract(value, '$.required') = 1 AND json_extract(value, '$.bucket') <> 'pass')
    THEN 'ready_for_human_merge'
  WHEN recovery_status IN ('orphaned', 'invalid') OR worktree_status IN ('missing', 'invalid')
    OR status IN ('review_fetch_failed', 'rework_failed', 'ci_failed', 'ci_pending', 'validation_failed', 'secret_scan_failed', 'approval_invalidated', 'commit_failed', 'push_failed', 'pr_failed')
    OR flow_status IN ('aborted', 'timed_out', 'error')
    OR (pr_number IS NOT NULL AND json_extract(payload_json, '$.prReview.state') IN ('CLOSED', 'MERGED'))
    THEN 'needs_attention'
  WHEN status IN ('awaiting_approval', 'awaiting_final_approval') THEN 'ready_for_approval'
  WHEN pr_number IS NOT NULL
    AND COALESCE(json_extract(payload_json, '$.prReview.state'), 'OPEN') = 'OPEN'
    AND COALESCE(json_extract(payload_json, '$.prReview.merged'), 0) = 0
    THEN 'pr_open'
  WHEN status IN ('draft', 'reviewed', 'validating', 'committing', 'pushing', 'creating_pr', 'fetching_review', 'reworking', 'reviewing_rework', 'committing_rework', 'pushing_rework', 'checking_ci')
    OR flow_status = 'running' THEN 'active'
  ELSE 'needs_attention'
END`;

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
    const profile = parseProfileSnapshot(task.profile ?? safeDefaultSnapshot(task.repoId));
    if (profile.repoId !== task.repoId) throw new Error("Task profile snapshot repository does not match the task");
    task.profile = profile;
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
      profileSnapshot: profile,
    };
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO tasks (
          task_id, repo_id, repo_name, repo_path, allowed_root, base_branch, task_branch,
          base_sha, origin_url, worktree_path, worktree_root, worktree_available, worktree_status,
          status, original_prompt, created_at, updated_at, flow_id, flow_status, final_output,
          diff_hash, approval_state, approval_purpose, approval_id, commit_sha, pr_number, pr_url,
          pr_head_sha, review_disposition, unresolved_count, ci_status, merge_readiness,
          recovery_status, recovery_message, payload_json, profile_id, profile_version, profile_snapshot_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
          recovery_message=excluded.recovery_message, payload_json=excluded.payload_json,
          profile_id=excluded.profile_id, profile_version=excluded.profile_version,
          profile_snapshot_json=excluded.profile_snapshot_json
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
        profile.profileId, profile.version, JSON.stringify(profile),
      );
      this.replaceFlowSteps(task.id, task.flowSteps ?? []);
    });
  }

  loadTasks(): RepoTask[] {
    const rows = this.database.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as TaskRow[];
    const stepStatement = this.database.prepare("SELECT * FROM flow_steps WHERE task_id = ? ORDER BY ordinal");
    return rows.map((row) => this.rowToTask(row, stepStatement.all(String(row.task_id)) as FlowStepRow[]));
  }

  markTaskProfileNeedsAttention(taskId: string, message: string) {
    this.database.prepare("UPDATE tasks SET recovery_status = 'needs_attention', recovery_message = ?, updated_at = ? WHERE task_id = ?")
      .run(message.slice(0, 1_000), new Date().toISOString(), taskId);
  }

  queryDashboard(input: DashboardQuery): { rows: DashboardRow[]; counts: DashboardCounts } {
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (input.repo) { filters.push("repo_id = ?"); values.push(input.repo); }
    if (input.status) { filters.push("status = ?"); values.push(input.status); }
    if (input.pr === "with_pr") filters.push("pr_number IS NOT NULL");
    if (input.pr === "without_pr") filters.push("pr_number IS NULL");
    if (input.search) {
      const pattern = `%${escapeLike(input.search.toLocaleLowerCase("en-US"))}%`;
      const prPattern = `%${escapeLike(input.search.replace(/^#/, ""))}%`;
      filters.push("(lower(repo_name) LIKE ? ESCAPE '\\' OR lower(task_branch) LIKE ? ESCAPE '\\' OR CAST(pr_number AS TEXT) LIKE ? ESCAPE '\\' OR lower(replace(replace(original_prompt, char(10), ' '), char(13), ' ')) LIKE ? ESCAPE '\\')");
      values.push(pattern, pattern, prPattern, pattern);
    }
    const baseWhere = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const countRows = this.database.prepare(`SELECT bucket, COUNT(*) AS count FROM (SELECT ${DASHBOARD_BUCKET_SQL} AS bucket FROM tasks ${baseWhere}) GROUP BY bucket`).all(...values) as Array<{ bucket: TaskBucket; count: number }>;
    const counts: DashboardCounts = { active: 0, needs_attention: 0, ready_for_approval: 0, pr_open: 0, ready_for_human_merge: 0, archived: 0 };
    for (const row of countRows) counts[row.bucket] = Number(row.count);

    const listFilters = [...filters];
    const listValues = [...values];
    if (!input.includeArchived && input.bucket !== "archived") listFilters.push("status <> 'archived' AND worktree_status <> 'removed'");
    if (input.bucket) { listFilters.push(`(${DASHBOARD_BUCKET_SQL}) = ?`); listValues.push(input.bucket); }
    const where = listFilters.length ? `WHERE ${listFilters.join(" AND ")}` : "";
    const order = input.sort === "created_desc" ? "created_at DESC" : input.sort === "repo_name" ? "repo_name COLLATE NOCASE ASC, updated_at DESC" : "updated_at DESC";
    const raw = this.database.prepare(`
      SELECT task_id, repo_id, repo_name, task_branch, base_branch, status, original_prompt,
        created_at, updated_at, pr_number, pr_url, recovery_status, recovery_message,
        worktree_status, worktree_available, payload_json, profile_id, profile_version, ${DASHBOARD_BUCKET_SQL} AS bucket
      FROM tasks ${where} ORDER BY ${order} LIMIT ?
    `).all(...listValues, input.limit) as TaskRow[];
    return { rows: raw.map(rowToDashboardRow), counts };
  }

  clearForTests() {
    this.transaction(() => {
      this.dropAppendOnlyTriggers();
      this.database.exec("DELETE FROM approval_events; DELETE FROM diff_versions; DELETE FROM step_versions; DELETE FROM task_events; DELETE FROM flow_steps; DELETE FROM tasks; DELETE FROM profile_audit_events; DELETE FROM project_profile_versions; DELETE FROM project_profiles;");
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

  loadProjectProfiles(): ProjectProfile[] {
    const rows = this.database.prepare("SELECT profile_json FROM project_profiles ORDER BY repo_id").all() as Array<{ profile_json: string }>;
    return rows.map((row) => profileFromStored(row.profile_json));
  }

  loadRepoProfile(repoId: string): ProjectProfile | undefined {
    const row = this.database.prepare("SELECT profile_json FROM project_profiles WHERE repo_id = ?").get(repoId) as { profile_json: string } | undefined;
    return row ? profileFromStored(row.profile_json) : undefined;
  }

  loadProfileVersions(profileId?: string): ProjectProfileVersion[] {
    const rows = (profileId
      ? this.database.prepare("SELECT * FROM project_profile_versions WHERE profile_id = ? ORDER BY version").all(profileId)
      : this.database.prepare("SELECT * FROM project_profile_versions ORDER BY profile_id, version").all()) as TaskRow[];
    return rows.map((row) => ({
      profileId: String(row.profile_id), version: Number(row.version), changedAt: String(row.changed_at),
      changedFields: JSON.parse(String(row.changed_fields_json)) as string[], actor: "user", snapshot: parseProfileSnapshot(JSON.parse(String(row.snapshot_json))),
    }));
  }

  loadProfileAuditEvents() {
    return (this.database.prepare("SELECT event_type, created_at, actor, repo_id, profile_id, profile_version, task_id FROM profile_audit_events ORDER BY sequence").all() as TaskRow[]).map((row) => ({
      type: String(row.event_type) as ProfileAuditEventType, createdAt: String(row.created_at), actor: "user" as const,
      repoId: String(row.repo_id), profileId: String(row.profile_id), profileVersion: Number(row.profile_version), taskId: optionalString(row.task_id),
    }));
  }

  createProjectProfile(profile: ProjectProfile) {
    const snapshot = parseProfileSnapshot(profile);
    this.transaction(() => {
      this.database.prepare(`INSERT INTO project_profiles(profile_id, repo_id, name, version, enabled, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(profile.profileId, profile.repoId, profile.name, profile.version, profile.enabled ? 1 : 0, JSON.stringify(profile), profile.createdAt, profile.updatedAt);
      this.database.prepare(`INSERT INTO project_profile_versions(profile_id, version, changed_at, changed_fields_json, actor, snapshot_json) VALUES (?, ?, ?, ?, 'user', ?)`)
        .run(profile.profileId, profile.version, profile.createdAt, JSON.stringify(["created"]), JSON.stringify(snapshot));
      this.appendProfileAudit("profile_created", profile.repoId, profile.profileId, profile.version);
      this.appendProfileAudit("profile_assigned", profile.repoId, profile.profileId, profile.version);
    });
  }

  updateProjectProfile(profile: ProjectProfile, changedFields: readonly string[]) {
    const snapshot = parseProfileSnapshot(profile);
    this.transaction(() => {
      const result = this.database.prepare(`UPDATE project_profiles SET name = ?, version = ?, enabled = ?, profile_json = ?, updated_at = ? WHERE profile_id = ? AND repo_id = ? AND version = ?`)
        .run(profile.name, profile.version, profile.enabled ? 1 : 0, JSON.stringify(profile), profile.updatedAt, profile.profileId, profile.repoId, profile.version - 1);
      if (Number(result.changes) !== 1) throw new Error("Profile was changed concurrently; reload and retry");
      this.database.prepare(`INSERT INTO project_profile_versions(profile_id, version, changed_at, changed_fields_json, actor, snapshot_json) VALUES (?, ?, ?, ?, 'user', ?)`)
        .run(profile.profileId, profile.version, profile.updatedAt, JSON.stringify(changedFields), JSON.stringify(snapshot));
      this.appendProfileAudit("profile_updated", profile.repoId, profile.profileId, profile.version);
      this.appendProfileAudit("profile_assigned", profile.repoId, profile.profileId, profile.version);
    });
  }

  appendProfileAudit(type: ProfileAuditEventType, repoId: string, profileId: string, profileVersion: number, taskId?: string) {
    if (!(["profile_created", "profile_updated", "profile_assigned", "profile_snapshot_created"] as const).includes(type)) throw new Error("Profile audit event type is invalid");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoId) || !/^[A-Za-z0-9._-]{1,160}$/.test(profileId) || !Number.isSafeInteger(profileVersion) || profileVersion < 1) throw new Error("Profile audit identity is invalid");
    this.database.prepare(`INSERT INTO profile_audit_events(event_id, event_type, created_at, actor, repo_id, profile_id, profile_version, task_id) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`)
      .run(randomUUID(), type, new Date().toISOString(), repoId, profileId, profileVersion, taskId ?? null);
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
    const parsedProfile = storedTaskProfile(row, payload);
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
      profile: parsedProfile.profile,
      profileSnapshotValid: parsedProfile.valid,
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
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(2, new Date().toISOString());
    });
    if (version < 2) version = 2;
    if (version < 3) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE project_profiles (
          profile_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0), enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
          profile_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE project_profile_versions (
          profile_id TEXT NOT NULL REFERENCES project_profiles(profile_id), version INTEGER NOT NULL CHECK(version > 0),
          changed_at TEXT NOT NULL, changed_fields_json TEXT NOT NULL,
          actor TEXT NOT NULL CHECK(actor = 'user'), snapshot_json TEXT NOT NULL,
          PRIMARY KEY(profile_id, version)
        );
        CREATE TABLE profile_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL CHECK(event_type IN ('profile_created', 'profile_updated', 'profile_assigned', 'profile_snapshot_created')),
          created_at TEXT NOT NULL, actor TEXT NOT NULL CHECK(actor = 'user'), repo_id TEXT NOT NULL,
          profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL CHECK(profile_version > 0), task_id TEXT
        );
        ALTER TABLE tasks ADD COLUMN profile_id TEXT;
        ALTER TABLE tasks ADD COLUMN profile_version INTEGER;
        ALTER TABLE tasks ADD COLUMN profile_snapshot_json TEXT;
        INSERT INTO project_profiles(profile_id, repo_id, name, version, enabled, profile_json, created_at, updated_at)
          SELECT lower(hex(randomblob(16))), repo_id, 'safe_default', 1, 1,
            json_object(
              'profileId', '', 'repoId', repo_id, 'name', 'safe_default', 'version', 1, 'enabled', json('true'),
              'roles', json_object('codex','implement','cursor','review_only','claude','review_only'),
              'validation', json_object('steps',json_array('npm_test','npm_lint','npm_typecheck','npm_build'),'missingScript','skip','timeout','standard'),
              'git', json_object('isolatedWorktreeRequired',json('true'),'directMainWriteForbidden',json('true'),'commitRequiresApproval',json('true'),'prRequired',json('true'),'mergeAllowedInApp',json('false'),'forcePushAllowed',json('false'),'deployAllowedInApp',json('false')),
              'approval', json_object('beforeCommit',json('true'),'beforeRework',json('true'),'diffHashRequired',json('true'),'secretScanRequired',json('true'),'validationRequired',json('true')),
              'cleanup', json_object('allowCleanWorktreeRemoval',json('true'),'allowDirtyWorktreeRemoval',json('false'),'requireConfirmationIfPrOpen',json('true'),'requireStrongWarningIfReadyForMerge',json('true'))
            ), MIN(created_at), MAX(updated_at)
          FROM tasks GROUP BY repo_id;
        UPDATE project_profiles SET profile_json = json_set(profile_json, '$.profileId', profile_id, '$.createdAt', created_at, '$.updatedAt', updated_at);
        INSERT INTO project_profile_versions(profile_id, version, changed_at, changed_fields_json, actor, snapshot_json)
          SELECT profile_id, 1, created_at, '["migration"]', 'user', json_remove(profile_json, '$.createdAt', '$.updatedAt') FROM project_profiles;
        UPDATE tasks SET
          profile_id = (SELECT profile_id FROM project_profiles WHERE project_profiles.repo_id = tasks.repo_id),
          profile_version = 1,
          profile_snapshot_json = (SELECT json_remove(profile_json, '$.createdAt', '$.updatedAt') FROM project_profiles WHERE project_profiles.repo_id = tasks.repo_id);
        INSERT INTO profile_audit_events(event_id, event_type, created_at, actor, repo_id, profile_id, profile_version, task_id)
          SELECT lower(hex(randomblob(16))), 'profile_snapshot_created', updated_at, 'user', repo_id, profile_id, profile_version, task_id FROM tasks;
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(3, new Date().toISOString());
    });
    this.createAppendOnlyTriggers();
  }

  private createAppendOnlyTriggers() {
    for (const table of ["task_events", "step_versions", "diff_versions", "approval_events", "project_profile_versions", "profile_audit_events"]) {
      this.database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      `);
    }
  }

  private dropAppendOnlyTriggers() {
    for (const table of ["task_events", "step_versions", "diff_versions", "approval_events", "project_profile_versions", "profile_audit_events"]) {
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
function escapeLike(value: string) { return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"); }
function optionalString(value: unknown) { return typeof value === "string" && value.length ? value : undefined; }
function optionalNumber(value: unknown) { return typeof value === "number" ? value : value === null || value === undefined ? undefined : Number(value); }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function objectOrUndefined(value: unknown) { return value && typeof value === "object" ? value : undefined; }
function parseObject(value: unknown): Record<string, unknown> {
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" ? parsed : {}; }
  catch { return {}; }
}
function profileFromStored(value: unknown): ProjectProfile {
  const parsed = parseObject(value);
  const snapshot = parseProfileSnapshot(parsed);
  if (typeof parsed.createdAt !== "string" || typeof parsed.updatedAt !== "string") throw new Error("Stored project profile timestamps are invalid");
  return { ...snapshot, createdAt: parsed.createdAt, updatedAt: parsed.updatedAt };
}
function storedTaskProfile(row: TaskRow, payload: Record<string, unknown>): { profile: ProjectProfileSnapshot; valid: boolean } {
  const raw = row.profile_snapshot_json ?? payload.profileSnapshot;
  try {
    const profile = parseProfileSnapshot(typeof raw === "string" ? JSON.parse(raw) : raw);
    const valid = profile.repoId === String(row.repo_id)
      && profile.profileId === String(row.profile_id)
      && profile.version === Number(row.profile_version);
    return { profile, valid };
  } catch {
    return { profile: safeDefaultSnapshot(String(row.repo_id), optionalString(row.profile_id) ?? `invalid-${String(row.repo_id)}`, optionalNumber(row.profile_version) ?? 1), valid: false };
  }
}
const metadataKeys = new Set(["durationMs", "diffHash", "commitSha", "prNumber", "changedFileCount", "additions", "deletions", "profileId", "profileVersion"]);
function validateMetadata(value: TaskEventMetadata | undefined) {
  if (!value) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (!metadataKeys.has(key)) throw new Error(`Task event metadata key ${JSON.stringify(key)} is forbidden`);
    if (item === undefined) continue;
    if (["durationMs", "changedFileCount", "additions", "deletions"].includes(key) && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "prNumber" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "diffHash" && (typeof item !== "string" || !/^[0-9a-f]{64}$/i.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "commitSha" && (typeof item !== "string" || !/^[0-9a-f]{40,64}$/i.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "profileId" && (typeof item !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "profileVersion" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
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

function rowToDashboardRow(row: TaskRow): DashboardRow {
  return {
    taskId: String(row.task_id), repoId: String(row.repo_id), repoName: String(row.repo_name),
    branch: String(row.task_branch), baseBranch: String(row.base_branch), status: String(row.status),
    originalPrompt: String(row.original_prompt), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    prNumber: optionalNumber(row.pr_number), prUrl: optionalString(row.pr_url),
    recoveryStatus: String(row.recovery_status), recoveryMessage: optionalString(row.recovery_message),
    worktreeStatus: String(row.worktree_status), worktreeAvailable: Number(row.worktree_available) === 1,
    bucket: String(row.bucket) as TaskBucket, payload: parseObject(row.payload_json),
    profileId: optionalString(row.profile_id), profileVersion: optionalNumber(row.profile_version),
  };
}
