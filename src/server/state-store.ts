import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION } from "./schema-compatibility";
import type { FlowStep } from "../agents/types";
import type { ProviderCompatibilitySnapshot } from "../health/types";
import type { CredentialCapability, CredentialStatus } from "../credentials/types";
import { redactKnownSecrets, redactKnownSecretsInValue } from "./credential-resolver";
import type { DashboardCounts, DashboardSort, PrFilter, TaskBucket } from "../dashboard/types";
import { parseProfileSnapshot, safeDefaultSnapshot, type ProjectProfile, type ProjectProfileSnapshot } from "../profiles/policy";
import { builtInTemplates, mergeTemplateWithProfile, parseTemplateSnapshot, snapshotTemplate, type RepoTemplateSettings, type TaskTemplate, type TaskTemplateSnapshot } from "../templates/policy";
import type { RepoTask } from "./tasks";
import { operationStates, operationTypes, retentionPresets, type BackupMetadata, type DurableOperation, type OperationState, type OperationType, type RetentionPreset, type SafeOperationMetadata } from "../operations/types";
import { secureStateDatabasePath } from "./state-path";
import type { AgentRole } from "../profiles/policy";
import type { RuntimePolicyClass, RuntimeViolation } from "../runtime/types";
import {
  defaultOutboundChannelConfig,
  type DeliveryStatus,
  type NotificationDelivery,
  type OutboundChannelConfig,
} from "../outbound/types";
import {
  defaultNotificationPreferences,
  notificationSeverities,
  notificationTypes,
  type AppNotification,
  type NotificationPreferences,
  type NotificationQuery,
  type NotificationSeverity,
  type NotificationType,
} from "../notifications/types";
import {
  findingEventTypes,
  type Finding,
  type FindingEvent,
  type FindingEventType,
  type HumanPriority,
  type RemediationPresenceFilter,
  type RemediationQueueCounts,
  type RemediationQueueItem,
  type RemediationQueueSort,
  type RemediationStage,
} from "../findings/types";

export const STATE_DIRECTORY = join(homedir(), ".multiagents");
export const STATE_DATABASE = join(STATE_DIRECTORY, "state.db");
export { APP_STATE_COMPAT } from "./schema-compatibility";
export const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
const MAX_STORED_PROMPT_CHARS = 20_000;
const MAX_STORED_OUTPUT_CHARS = 1_000_000;

export const taskEventTypes = [
  "task_created", "flow_started", "step_started", "step_completed", "step_failed", "step_rerun", "step_stale",
  "flow_completed", "flow_aborted", "approval_issued", "approval_invalidated", "approval_accepted", "approval_failed",
  "validation_started", "validation_passed", "validation_failed", "diff_generated", "commit_created", "branch_pushed",
  "pr_created", "pr_review_fetched", "rework_started", "rework_completed", "ready_for_human_merge", "task_archived",
  "task_resumed", "worktree_cleanup_requested", "worktree_removed", "pr_status_refreshed",
  "worktree_reassociation_previewed", "worktree_reassociated",
  "profile_snapshot_created", "template_snapshot_created",
  "finding_created", "finding_status_changed", "finding_converted", "implementation_task_created",
  "runtime_policy_created", "runtime_execution_started", "runtime_execution_completed", "runtime_violation_detected",
  "agent_lifecycle_recorded",
  "os_sandbox_created", "os_sandbox_failed", "os_sandbox_violation", "os_sandbox_process_cleanup", "os_sandbox_finalization_unconfirmed", "os_sandbox_finalization_persistence_failed",
  "human_gate_rejected", "approval_snapshot_mismatch", "post_commit_verification_failed",
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
  templateId: string;
  templateVersion: number;
  findingId: string;
  sourceTaskId: string;
  agent: "codex" | "cursor" | "claude";
  role: AgentRole;
  policyClass: RuntimePolicyClass;
  runtimePolicyVersion: number;
  violationType: RuntimeViolation;
  sandboxProfile: import("./os-sandbox").OsSandboxProfile;
  capabilityClass: string;
  failureCode: import("./os-sandbox").SandboxFailureCode;
  lifecycle: import("../agents/types").AgentLifecycleTelemetry;
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
export type UnresolvedAgentProcess = {
  executionId: string;
  provider: "codex" | "cursor" | "claude";
  pid: number;
  pgid: number;
  leaderStartTicks: string;
  runtimeBindingPath?: string;
  createdAt: string;
  phase: "UNCONFIRMED" | "PROCESS_GONE_CLEANUP_PENDING" | "PROCESS_GONE_CLEANED";
};

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
  templateId?: string;
  templateVersion?: number;
  sourceFindingId?: string;
  sourceTaskId?: string;
};

export type RemediationQueueQuery = {
  repo?: string;
  severity?: Finding["severity"];
  priority?: HumanPriority;
  status?: Finding["status"];
  stage?: RemediationStage;
  pr: RemediationPresenceFilter;
  converted: RemediationPresenceFilter;
  search?: string;
  sort: RemediationQueueSort;
  includeDismissed: boolean;
  includeResolved: boolean;
  limit: number;
  offset: number;
  findingId?: string;
};

export type ProfileAuditEventType = "profile_created" | "profile_updated" | "profile_assigned" | "profile_snapshot_created";
export type ProjectProfileVersion = { profileId: string; version: number; changedAt: string; changedFields: string[]; actor: "user"; snapshot: ProjectProfileSnapshot };
export type TemplateAuditEventType = "template_enabled" | "template_disabled" | "default_template_changed" | "template_snapshot_created";
export type TaskTemplateVersion = { repoId: string; templateId: string; version: number; changedAt: string; changedFields: string[]; actor: "user"; snapshot: TaskTemplateSnapshot };

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

const SAFE_IMPLEMENTATION_PR_REVIEW_SQL = "CASE WHEN json_valid(i.payload_json) THEN json_extract(i.payload_json, '$.prReview') ELSE NULL END";
const REMEDIATION_STAGE_SQL = `CASE
  WHEN f.resolved_at IS NOT NULL THEN 'resolved'
  WHEN f.status = 'dismissed' THEN 'dismissed'
  WHEN s.task_id IS NULL THEN 'needs_attention'
  WHEN s.template_id IS NULL OR s.template_version IS NULL OR NOT json_valid(s.template_snapshot_json) THEN 'needs_attention'
  WHEN f.status = 'converted' AND (f.converted_task_id IS NULL OR i.task_id IS NULL) THEN 'needs_attention'
  WHEN i.task_id IS NOT NULL AND (i.source_finding_id IS NULL OR i.source_finding_id <> f.finding_id OR i.source_task_id <> f.source_task_id) THEN 'needs_attention'
  WHEN i.task_id IS NOT NULL AND (${SAFE_IMPLEMENTATION_PR_REVIEW_SQL} IS NOT NULL)
    AND (COALESCE(json_extract(${SAFE_IMPLEMENTATION_PR_REVIEW_SQL}, '$.merged'), 0) = 1 OR upper(COALESCE(json_extract(${SAFE_IMPLEMENTATION_PR_REVIEW_SQL}, '$.state'), '')) = 'MERGED')
    THEN 'resolved_candidate'
  WHEN i.task_id IS NOT NULL AND (
    i.recovery_status IN ('needs_attention','orphaned','invalid') OR i.worktree_status IN ('missing','invalid')
    OR i.status IN ('review_fetch_failed','rework_failed','ci_failed','validation_failed','secret_scan_failed','approval_invalidated','commit_failed','push_failed','pr_failed')
    OR (i.pr_number IS NOT NULL AND upper(COALESCE(json_extract(${SAFE_IMPLEMENTATION_PR_REVIEW_SQL}, '$.state'), 'OPEN')) = 'CLOSED')
    OR i.template_id IS NULL OR i.template_version IS NULL OR NOT json_valid(i.template_snapshot_json)
  ) THEN 'needs_attention'
  WHEN f.status = 'accepted' AND i.task_id IS NULL THEN 'implementation_not_created'
  WHEN f.status = 'open' AND i.task_id IS NULL THEN 'untriaged'
  WHEN f.status = 'accepted' THEN 'accepted'
  WHEN i.merge_readiness = 'ready_for_human_merge' AND i.pr_number IS NOT NULL THEN 'ready_for_human_merge'
  WHEN i.pr_number IS NOT NULL THEN 'pr_open'
  WHEN i.status IN ('awaiting_approval','awaiting_final_approval') THEN 'awaiting_approval'
  WHEN i.task_id IS NOT NULL THEN 'implementation_active'
  ELSE 'needs_attention'
END`;

const REMEDIATION_BASE_SQL = `WITH remediation_base AS (
  SELECT
    f.*, s.repo_id, s.repo_name, s.template_version AS source_template_version,
    CASE WHEN json_valid(s.template_snapshot_json) THEN json_extract(s.template_snapshot_json, '$.name') END AS source_template_name,
    s.origin_url AS source_origin_url,
    i.task_id AS implementation_task_id, i.status AS implementation_task_status,
    i.recovery_status AS implementation_recovery_status, i.recovery_message AS implementation_recovery_message,
    i.worktree_status AS implementation_worktree_status, i.source_finding_id AS implementation_source_finding_id,
    i.source_task_id AS implementation_source_task_id,
    i.pr_number, i.pr_url, i.origin_url AS implementation_origin_url, i.merge_readiness,
    CASE WHEN json_valid(i.payload_json) THEN json_extract(i.payload_json, '$.prReview.state') END AS pr_state,
    ${REMEDIATION_STAGE_SQL} AS remediation_stage
  FROM findings f
  LEFT JOIN tasks s ON s.task_id = f.source_task_id
  LEFT JOIN tasks i ON i.task_id = f.converted_task_id
)`;

export class StateStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  private closed = false;

  constructor(path = STATE_DATABASE) {
    this.path = path;
    secureStateDatabasePath(path);
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close() { if (!this.closed) { this.closed = true; this.database.close(); } }

  schemaVersion() {
    const row = this.database.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null };
    return row.version ?? 0;
  }

  integrityCheck() {
    const row = this.database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    return String(row.integrity_check);
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
    const template = parseTemplateSnapshot(task.template ?? mergeTemplateWithProfile(snapshotTemplate(builtInTemplates(task.repoId)[0]), profile));
    if (template.repoId !== task.repoId) throw new Error("Task template snapshot repository does not match the task");
    task.template = template;
    const payload = redactKnownSecretsInValue({
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
      runtimeViolation: task.runtimeViolation,
      localClonePath: task.localClonePath,
      baseState: task.baseState,
      baseAheadCount: task.baseAheadCount,
      profileSnapshot: profile,
      templateSnapshot: template,
    });
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO tasks (
          task_id, repo_id, repo_name, repo_path, allowed_root, base_branch, task_branch,
          base_sha, origin_url, worktree_path, worktree_root, worktree_available, worktree_status,
          status, original_prompt, created_at, updated_at, flow_id, flow_status, final_output,
          diff_hash, approval_state, approval_purpose, approval_id, commit_sha, pr_number, pr_url,
          pr_head_sha, review_disposition, unresolved_count, ci_status, merge_readiness,
          recovery_status, recovery_message, payload_json, profile_id, profile_version, profile_snapshot_json,
          template_id, template_version, template_snapshot_json
          , source_finding_id, source_task_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
          profile_snapshot_json=excluded.profile_snapshot_json,
          template_id=excluded.template_id, template_version=excluded.template_version,
          template_snapshot_json=excluded.template_snapshot_json,
          source_finding_id=excluded.source_finding_id, source_task_id=excluded.source_task_id
      `).run(
        task.id, task.repoId, task.repoName, task.repoPath, task.allowedRoot, task.baseBranch, task.branch,
        task.baseSha, task.originUrl ?? null, task.worktreePath, task.worktreeRoot,
        task.worktreeAvailable ? 1 : 0, task.worktreeStatus, task.status,
        bounded(redactKnownSecrets(task.prompt), MAX_STORED_PROMPT_CHARS), task.createdAt, task.updatedAt,
        task.flowId ?? null, task.flowStatus ?? null, bounded(redactKnownSecrets(task.finalOutput ?? ""), MAX_STORED_OUTPUT_CHARS),
        task.diffHash ?? null, task.approvalState, task.approvalPurpose ?? null, task.approvalId ?? null,
        task.commitSha ?? null, task.prNumber ?? null, task.prUrl ?? null,
        review?.headSha ?? task.latestPushedSha ?? task.commitSha ?? null,
        reviewDisposition ?? null, review?.unresolvedCount ?? null, ciStatus ?? null,
        task.status === "ready_for_human_merge" ? "ready_for_human_merge" : null,
        task.recoveryStatus, task.recoveryMessage ? redactKnownSecrets(task.recoveryMessage) : null, JSON.stringify(payload),
        profile.profileId, profile.version, JSON.stringify(profile),
        template.templateId, template.version, JSON.stringify(template),
        task.sourceFindingId ?? null, task.sourceTaskId ?? null,
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
        worktree_status, worktree_available, payload_json, profile_id, profile_version,
        template_id, template_version, ${DASHBOARD_BUCKET_SQL} AS bucket
        , source_finding_id, source_task_id
      FROM tasks ${where} ORDER BY ${order} LIMIT ?
    `).all(...listValues, input.limit) as TaskRow[];
    return { rows: raw.map(rowToDashboardRow), counts };
  }

  queryRemediationQueue(input: RemediationQueueQuery, now = new Date()): { rows: RemediationQueueItem[]; counts: RemediationQueueCounts } {
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (!input.includeDismissed) filters.push("remediation_stage <> 'dismissed'");
    if (!input.includeResolved) filters.push("remediation_stage <> 'resolved'");
    if (input.findingId) { filters.push("finding_id = ?"); values.push(input.findingId); }
    if (input.repo) { filters.push("repo_id = ?"); values.push(input.repo); }
    if (input.severity) { filters.push("severity = ?"); values.push(input.severity); }
    if (input.priority) { filters.push("human_priority = ?"); values.push(input.priority); }
    if (input.status) { filters.push("status = ?"); values.push(input.status); }
    if (input.stage) { filters.push("remediation_stage = ?"); values.push(input.stage); }
    if (input.pr === "yes") filters.push("pr_number IS NOT NULL");
    if (input.pr === "no") filters.push("pr_number IS NULL");
    if (input.converted === "yes") filters.push("converted_task_id IS NOT NULL");
    if (input.converted === "no") filters.push("converted_task_id IS NULL");
    if (input.search) {
      const pattern = `%${escapeLike(input.search.toLocaleLowerCase("en-US"))}%`;
      const prPattern = `%${escapeLike(input.search.replace(/^#/, ""))}%`;
      filters.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(COALESCE(category, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(repo_name, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(affected_paths_json, '')) LIKE ? ESCAPE '\\' OR CAST(pr_number AS TEXT) LIKE ? ESCAPE '\\')");
      values.push(pattern, pattern, pattern, pattern, prPattern);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const humanOrder = "CASE human_priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
    const severityOrder = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
    const stageOrder = "CASE remediation_stage WHEN 'implementation_not_created' THEN 0 WHEN 'needs_attention' THEN 1 WHEN 'untriaged' THEN 2 WHEN 'accepted' THEN 3 WHEN 'implementation_active' THEN 4 WHEN 'awaiting_approval' THEN 5 WHEN 'pr_open' THEN 6 WHEN 'ready_for_human_merge' THEN 7 WHEN 'resolved_candidate' THEN 8 WHEN 'resolved' THEN 9 ELSE 10 END";
    const order = input.sort === "severity"
      ? `${severityOrder}, ${humanOrder}, created_at ASC, finding_id ASC`
      : input.sort === "age"
        ? "created_at ASC, finding_id ASC"
        : input.sort === "updated"
          ? "updated_at DESC, finding_id ASC"
          : input.sort === "repo"
            ? `repo_name COLLATE NOCASE ASC, ${humanOrder}, ${severityOrder}, created_at ASC, finding_id ASC`
            : `${humanOrder}, ${severityOrder}, ${stageOrder}, created_at ASC, finding_id ASC`;
    const count = this.database.prepare(`${REMEDIATION_BASE_SQL}
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END), 0) AS critical,
        COALESCE(SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END), 0) AS high,
        COALESCE(SUM(CASE WHEN remediation_stage = 'implementation_not_created' THEN 1 ELSE 0 END), 0) AS accepted_not_converted,
        COALESCE(SUM(CASE WHEN remediation_stage = 'needs_attention' THEN 1 ELSE 0 END), 0) AS needs_attention,
        COALESCE(SUM(CASE WHEN remediation_stage = 'ready_for_human_merge' THEN 1 ELSE 0 END), 0) AS ready_for_merge
      FROM remediation_base ${where}
    `).get(...values) as Record<string, unknown>;
    const raw = this.database.prepare(`${REMEDIATION_BASE_SQL}
      SELECT * FROM remediation_base ${where} ORDER BY ${order} LIMIT ? OFFSET ?
    `).all(...values, input.limit, input.offset) as TaskRow[];
    return {
      rows: raw.map((row) => rowToRemediationQueueItem(row, now)),
      counts: {
        total: Number(count.total), critical: Number(count.critical), high: Number(count.high),
        acceptedNotConverted: Number(count.accepted_not_converted), needsAttention: Number(count.needs_attention),
        readyForMerge: Number(count.ready_for_merge),
      },
    };
  }

  clearForTests() {
    this.transaction(() => {
      this.dropAppendOnlyTriggers();
      this.database.exec("DELETE FROM unresolved_agent_processes; DELETE FROM provider_compatibility_snapshots; DELETE FROM provider_compatibility_acknowledgements; DELETE FROM cleanup_audit_events; DELETE FROM retention_policy; DELETE FROM backup_metadata; DELETE FROM operations; DELETE FROM credential_audit_events; DELETE FROM outbound_audit_events; DELETE FROM notification_deliveries; DELETE FROM outbound_channel_settings; DELETE FROM notification_audit_events; DELETE FROM notifications; DELETE FROM watch_rule_state; DELETE FROM notification_preferences; DELETE FROM finding_events; DELETE FROM findings; DELETE FROM approval_events; DELETE FROM diff_versions; DELETE FROM step_versions; DELETE FROM task_events; DELETE FROM flow_steps; DELETE FROM tasks; DELETE FROM template_audit_events; DELETE FROM task_template_versions; DELETE FROM repo_template_settings; DELETE FROM task_templates; DELETE FROM profile_audit_events; DELETE FROM project_profile_versions; DELETE FROM project_profiles;");
      this.createAppendOnlyTriggers();
    });
  }

  loadTaskIdentity(taskId: string): { repoId: string; repoName: string } | undefined {
    const row = this.database.prepare("SELECT repo_id, repo_name FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    return row ? { repoId: String(row.repo_id), repoName: String(row.repo_name) } : undefined;
  }

  saveProviderCompatibility(snapshot: ProviderCompatibilitySnapshot) {
    const statuses = ["supported", "supported_with_warning", "version_probe_failed", "unsupported_version", "missing", "credential_unavailable", "sandbox_incompatible", "flag_incompatible", "launch_failed"];
    if (!["codex", "cursor", "claude"].includes(snapshot.provider) || !statuses.includes(snapshot.status)) throw new Error("Provider compatibility snapshot is invalid");
    if (snapshot.version && !/^\d+(?:\.\d+){2}$/.test(snapshot.version)) throw new Error("Provider compatibility version is invalid");
    // Identity is metadata only (paths and stat fields), never credential
    // content. A complete launcher chain can legitimately exceed 500 chars.
    if (snapshot.identity && (snapshot.identity.length > 4_000 || /[\r\n]/.test(snapshot.identity))) throw new Error("Provider compatibility identity is invalid");
    this.database.prepare(`INSERT INTO provider_compatibility_snapshots
      (provider, version, status, flags_compatible, credential_status, sandbox_compatible, launch_compatible, checked_at, identity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.provider, snapshot.version ?? null, snapshot.status, Number(snapshot.flagsCompatible), snapshot.credentialStatus, Number(snapshot.sandboxCompatible), Number(snapshot.launchCompatible), snapshot.checkedAt, snapshot.identity ?? null);
    this.database.prepare(`DELETE FROM provider_compatibility_snapshots WHERE snapshot_id IN (
      SELECT snapshot_id FROM provider_compatibility_snapshots WHERE provider = ? ORDER BY snapshot_id DESC LIMIT -1 OFFSET 20
    )`).run(snapshot.provider);
  }

  loadLatestProviderCompatibility(provider: string): (ProviderCompatibilitySnapshot & { identity?: string }) | undefined {
    if (!["codex", "cursor", "claude"].includes(provider)) return undefined;
    const row = this.database.prepare("SELECT * FROM provider_compatibility_snapshots WHERE provider = ? ORDER BY snapshot_id DESC LIMIT 1").get(provider) as TaskRow | undefined;
    return row ? rowToProviderCompatibility(row) : undefined;
  }

  loadProviderCompatibilityHistory(provider: string, limit = 20): Array<ProviderCompatibilitySnapshot & { identity?: string }> {
    if (!["codex", "cursor", "claude"].includes(provider) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) return [];
    return (this.database.prepare("SELECT * FROM provider_compatibility_snapshots WHERE provider = ? ORDER BY snapshot_id DESC LIMIT ?").all(provider, limit) as TaskRow[]).map(rowToProviderCompatibility);
  }

  acknowledgeProviderCompatibility(provider: string, version: string) {
    if (!["codex", "cursor", "claude"].includes(provider) || !/^\d+(?:\.\d+){2}$/.test(version)) throw new Error("Provider acknowledgement is invalid");
    this.database.prepare(`INSERT INTO provider_compatibility_acknowledgements(provider, version, acknowledged_at) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET version = excluded.version, acknowledged_at = excluded.acknowledged_at`).run(provider, version, new Date().toISOString());
  }

  loadProviderCompatibilityAcknowledgement(provider: string) {
    const row = this.database.prepare("SELECT version FROM provider_compatibility_acknowledgements WHERE provider = ?").get(provider) as { version?: string } | undefined;
    return row?.version;
  }

  createBuiltInNotification(input: Omit<AppNotification, "notificationId" | "status" | "createdAt" | "readAt" | "dismissedAt" | "deliveries">): AppNotification | undefined {
    if (!notificationTypes.includes(input.type) || !notificationSeverities.includes(input.severity)) throw new Error("Notification type or severity is invalid");
    if (!/^[A-Za-z0-9:._-]{1,500}$/.test(input.dedupeKey)) throw new Error("Notification dedupe key is invalid");
    if (!input.title || input.title.length > 120 || !input.message || input.message.length > 240) throw new Error("Notification content is invalid");
    if (input.repoId && !/^[A-Za-z0-9._-]{1,100}$/.test(input.repoId)) throw new Error("Notification repository is invalid");
    for (const id of [input.taskId, input.findingId]) if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Notification relation is invalid");
    if (input.prNumber !== undefined && (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1)) throw new Error("Notification PR is invalid");
    const notificationId = randomUUID();
    const createdAt = new Date().toISOString();
    const result = this.database.prepare(`INSERT OR IGNORE INTO notifications
      (notification_id, type, severity, repo_id, repo_name, task_id, finding_id, pr_number, title, message, status, dedupe_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)`)
      .run(notificationId, input.type, input.severity, input.repoId ?? null, input.repoName?.slice(0, 160) ?? null, input.taskId ?? null, input.findingId ?? null, input.prNumber ?? null, input.title, input.message, input.dedupeKey, createdAt);
    if (Number(result.changes) !== 1) return undefined;
    this.appendNotificationAudit("notification_created", notificationId, input.type);
    return this.loadNotification(notificationId);
  }

  queryNotifications(input: NotificationQuery): { notifications: AppNotification[]; unreadCount: number } {
    const filters = ["status <> 'dismissed'"];
    const values: Array<string | number> = [];
    if (input.unreadOnly) filters.push("status = 'unread'");
    if (input.severity) { filters.push("severity = ?"); values.push(input.severity); }
    if (input.repoId) { filters.push("repo_id = ?"); values.push(input.repoId); }
    if (input.type) { filters.push("type = ?"); values.push(input.type); }
    const rows = this.database.prepare(`SELECT * FROM notifications WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, notification_id DESC LIMIT ?`).all(...values, input.limit) as TaskRow[];
    const unread = this.database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE status = 'unread'").get() as { count: number };
    return { notifications: rows.map((row) => ({ ...rowToNotification(row), deliveries: this.loadNotificationDeliveries(String(row.notification_id)) })), unreadCount: Number(unread.count) };
  }

  /** Retention evaluation includes dismissed rows, which the inbox intentionally hides. */
  loadNotificationsForRetention(): AppNotification[] {
    const rows = this.database.prepare("SELECT * FROM notifications ORDER BY created_at ASC, notification_id ASC").all() as TaskRow[];
    return rows.map((row) => ({ ...rowToNotification(row), deliveries: this.loadNotificationDeliveries(String(row.notification_id)) }));
  }

  deleteNotificationForRetention(notificationId: string) {
    requireUuid(notificationId, "Notification ID");
    this.transaction(() => {
      this.database.prepare("DELETE FROM notification_deliveries WHERE notification_id = ?").run(notificationId);
      this.database.prepare("DELETE FROM notifications WHERE notification_id = ?").run(notificationId);
    });
  }

  deleteDeliveredOutboundForRetention(notificationId: string) {
    requireUuid(notificationId, "Notification ID");
    this.database.prepare("DELETE FROM notification_deliveries WHERE notification_id = ? AND channel = 'slack' AND status = 'delivered'").run(notificationId);
  }

  markNotificationRead(notificationId: string): AppNotification | undefined {
    requireUuid(notificationId, "Notification ID");
    const now = new Date().toISOString();
    const result = this.database.prepare("UPDATE notifications SET status = 'read', read_at = COALESCE(read_at, ?) WHERE notification_id = ? AND status = 'unread'").run(now, notificationId);
    const value = this.loadNotification(notificationId);
    if (Number(result.changes) === 1 && value) this.appendNotificationAudit("notification_read", notificationId, value.type);
    return value;
  }

  dismissNotification(notificationId: string): AppNotification | undefined {
    requireUuid(notificationId, "Notification ID");
    const now = new Date().toISOString();
    const result = this.database.prepare("UPDATE notifications SET status = 'dismissed', dismissed_at = ? WHERE notification_id = ? AND status <> 'dismissed'").run(now, notificationId);
    const value = this.loadNotification(notificationId);
    if (Number(result.changes) === 1 && value) this.appendNotificationAudit("notification_dismissed", notificationId, value.type);
    return value;
  }

  markAllNotificationsRead(): number {
    const now = new Date().toISOString();
    const unread = this.database.prepare("SELECT notification_id, type FROM notifications WHERE status = 'unread'").all() as Array<{ notification_id: string; type: NotificationType }>;
    this.transaction(() => {
      this.database.prepare("UPDATE notifications SET status = 'read', read_at = ? WHERE status = 'unread'").run(now);
      for (const item of unread) this.appendNotificationAudit("notification_read", item.notification_id, item.type);
    });
    return unread.length;
  }

  loadNotificationPreferences(): NotificationPreferences {
    const row = this.database.prepare("SELECT preferences_json FROM notification_preferences WHERE singleton = 1").get() as { preferences_json: string } | undefined;
    if (!row) return { ...defaultNotificationPreferences };
    const value = parseObject(row.preferences_json);
    return Object.fromEntries(Object.keys(defaultNotificationPreferences).map((key) => [key, value[key] === true])) as NotificationPreferences;
  }

  saveNotificationPreferences(preferences: NotificationPreferences) {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO notification_preferences(singleton, preferences_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at`).run(JSON.stringify(preferences), now);
    this.appendNotificationAudit("notification_preferences_updated");
    return preferences;
  }

  loadOutboundChannelConfig(): OutboundChannelConfig {
    const row = this.database.prepare("SELECT settings_json FROM outbound_channel_settings WHERE channel = 'slack'").get() as { settings_json: string } | undefined;
    if (!row) return { ...defaultOutboundChannelConfig };
    const value = parseObject(row.settings_json);
    return {
      ...defaultOutboundChannelConfig,
      ...Object.fromEntries(Object.keys(defaultOutboundChannelConfig).map((key) => [key, value[key] ?? defaultOutboundChannelConfig[key as keyof OutboundChannelConfig]])),
      channel: "slack",
    } as OutboundChannelConfig;
  }

  saveOutboundChannelConfig(config: OutboundChannelConfig) {
    this.database.prepare(`INSERT INTO outbound_channel_settings(channel, settings_json, updated_at) VALUES ('slack', ?, ?)
      ON CONFLICT(channel) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(config), new Date().toISOString());
    this.appendOutboundAudit("outbound_preferences_updated", undefined, "suppressed");
    return config;
  }

  reserveNotificationDelivery(notificationId: string, status: Extract<DeliveryStatus, "pending" | "suppressed">, errorCode?: string, lease?: { attemptId: string; startedAt: string; leaseExpiresAt: string }) {
    requireUuid(notificationId, "Notification ID");
    const result = this.database.prepare(`INSERT OR IGNORE INTO notification_deliveries
      (notification_id, channel, status, attempted_at, delivered_at, error_code, attempt_id, started_at, lease_expires_at)
      VALUES (?, 'slack', ?, NULL, NULL, ?, ?, ?, ?)`)
      .run(notificationId, status, boundedErrorCode(errorCode) ?? null, lease?.attemptId ?? null, lease?.startedAt ?? null, lease?.leaseExpiresAt ?? null);
    return Number(result.changes) === 1;
  }

  markNotificationDeliveryAttempted(notificationId: string) {
    requireUuid(notificationId, "Notification ID");
    const result = this.database.prepare("UPDATE notification_deliveries SET attempted_at = COALESCE(attempted_at, ?), started_at = COALESCE(started_at, ?) WHERE notification_id = ? AND channel = 'slack' AND status = 'pending'")
      .run(new Date().toISOString(), new Date().toISOString(), notificationId);
    if (Number(result.changes) !== 1) throw new Error("Slack delivery is not pending");
  }

  completeNotificationDelivery(notificationId: string, status: Extract<DeliveryStatus, "delivered" | "failed">, errorCode?: string) {
    requireUuid(notificationId, "Notification ID");
    const now = new Date().toISOString();
    const result = this.database.prepare(`UPDATE notification_deliveries SET status = ?, delivered_at = ?, error_code = ?, lease_expires_at = NULL
      WHERE notification_id = ? AND channel = 'slack' AND status = 'pending'`)
      .run(status, status === "delivered" ? now : null, status === "failed" ? boundedErrorCode(errorCode) ?? "unknown" : null, notificationId);
    if (Number(result.changes) !== 1) throw new Error("Slack delivery completion state is invalid");
  }

  beginNotificationDeliveryRetry(notificationId: string, lease?: { attemptId: string; startedAt: string; leaseExpiresAt: string }) {
    requireUuid(notificationId, "Notification ID");
    const result = this.database.prepare(`UPDATE notification_deliveries SET status = 'pending', attempted_at = NULL, delivered_at = NULL, error_code = NULL,
      attempt_id = ?, started_at = ?, lease_expires_at = ?
      WHERE notification_id = ? AND channel = 'slack' AND status IN ('failed','ambiguous')`).run(lease?.attemptId ?? null, lease?.startedAt ?? null, lease?.leaseExpiresAt ?? null, notificationId);
    return Number(result.changes) === 1;
  }

  expireSlackDeliveryLeases(now = new Date()) {
    const result = this.database.prepare(`UPDATE notification_deliveries SET status = 'ambiguous', error_code = 'delivery_outcome_unknown', lease_expires_at = NULL
      WHERE channel = 'slack' AND status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`).run(now.toISOString());
    return Number(result.changes);
  }

  markAmbiguousSlackDelivered(notificationId: string) {
    requireUuid(notificationId, "Notification ID");
    const result = this.database.prepare(`UPDATE notification_deliveries SET status = 'delivered', delivered_at = ?, error_code = NULL, lease_expires_at = NULL
      WHERE notification_id = ? AND channel = 'slack' AND status = 'ambiguous'`).run(new Date().toISOString(), notificationId);
    return Number(result.changes) === 1;
  }

  dismissAmbiguousSlackDelivery(notificationId: string) {
    requireUuid(notificationId, "Notification ID");
    const result = this.database.prepare(`UPDATE notification_deliveries SET status = 'suppressed', error_code = 'human_dismissed', lease_expires_at = NULL
      WHERE notification_id = ? AND channel = 'slack' AND status = 'ambiguous'`).run(notificationId);
    return Number(result.changes) === 1;
  }

  loadNotificationDelivery(notificationId: string): NotificationDelivery | undefined {
    requireUuid(notificationId, "Notification ID");
    const row = this.database.prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel = 'slack'").get(notificationId) as TaskRow | undefined;
    return row ? rowToNotificationDelivery(row) : undefined;
  }

  loadNotificationDeliveries(notificationId: string): NotificationDelivery[] {
    requireUuid(notificationId, "Notification ID");
    return (this.database.prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? ORDER BY channel").all(notificationId) as TaskRow[]).map(rowToNotificationDelivery);
  }

  appendOutboundAudit(eventType: "outbound_delivery_attempted" | "outbound_delivery_succeeded" | "outbound_delivery_failed" | "outbound_delivery_retried" | "outbound_preferences_updated" | "outbound_delivery_ambiguous" | "outbound_delivery_marked_delivered" | "outbound_delivery_dismissed", notificationId: string | undefined, status: DeliveryStatus) {
    if (notificationId) requireUuid(notificationId, "Notification ID");
    this.database.prepare("INSERT INTO outbound_audit_events(event_id, event_type, notification_id, channel, status, created_at) VALUES (?, ?, ?, 'slack', ?, ?)")
      .run(randomUUID(), eventType, notificationId ?? null, status, new Date().toISOString());
  }

  loadOutboundAuditEvents() {
    return this.database.prepare("SELECT event_type, notification_id, channel, status, created_at FROM outbound_audit_events ORDER BY sequence").all();
  }

  appendCredentialAudit(eventType: "credential_resolution_failed" | "credential_status_checked", capability: CredentialCapability, status: CredentialStatus) {
    this.database.prepare("INSERT INTO credential_audit_events(event_id, event_type, capability, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), eventType, capability, status, new Date().toISOString());
  }

  loadCredentialAuditEvents() {
    return this.database.prepare("SELECT event_type, capability, status, created_at FROM credential_audit_events ORDER BY sequence").all();
  }

  createOperation(input: {
    type: OperationType;
    taskId?: string;
    findingId?: string;
    notificationId?: string;
    idempotencyKey: string;
    safeMetadata?: SafeOperationMetadata;
  }): DurableOperation {
    if (!operationTypes.includes(input.type)) throw new Error("Operation type is invalid");
    if (!/^[A-Za-z0-9:._/-]{1,500}$/.test(input.idempotencyKey)) throw new Error("Operation idempotency key is invalid");
    for (const id of [input.taskId, input.findingId, input.notificationId]) if (id) requireUuid(id, "Operation relation");
    const metadata = safeOperationMetadata(input.safeMetadata ?? {});
    const operationId = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT OR IGNORE INTO operations
      (operation_id, operation_type, task_id, finding_id, notification_id, idempotency_key, state, safe_metadata_json, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, ?, ?)`)
      .run(operationId, input.type, input.taskId ?? null, input.findingId ?? null, input.notificationId ?? null, input.idempotencyKey, JSON.stringify(metadata), now, now);
    const operation = this.loadOperationByKey(input.idempotencyKey);
    if (!operation || operation.type !== input.type || operation.taskId !== input.taskId || operation.findingId !== input.findingId || operation.notificationId !== input.notificationId) {
      throw new Error("Operation idempotency key conflicts with another logical operation");
    }
    return operation;
  }

  updateOperation(operationId: string, state: OperationState, safeMetadata?: SafeOperationMetadata, errorCode?: string) {
    requireUuid(operationId, "Operation ID");
    if (!operationStates.includes(state)) throw new Error("Operation state is invalid");
    const current = this.loadOperation(operationId);
    if (!current) throw new Error("Operation not found");
    const metadata = safeOperationMetadata({ ...current.safeMetadata, ...(safeMetadata ?? {}) });
    this.database.prepare("UPDATE operations SET state = ?, safe_metadata_json = ?, error_code = ?, updated_at = ? WHERE operation_id = ?")
      .run(state, JSON.stringify(metadata), boundedErrorCode(errorCode) ?? null, new Date().toISOString(), operationId);
    return this.loadOperation(operationId)!;
  }

  loadOperation(operationId: string): DurableOperation | undefined {
    requireUuid(operationId, "Operation ID");
    const row = this.database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as TaskRow | undefined;
    return row ? rowToOperation(row) : undefined;
  }

  loadOperationByKey(idempotencyKey: string): DurableOperation | undefined {
    const row = this.database.prepare("SELECT * FROM operations WHERE idempotency_key = ?").get(idempotencyKey) as TaskRow | undefined;
    return row ? rowToOperation(row) : undefined;
  }

  loadCleanupOperations(type: Extract<OperationType, "cleanup_node_modules">, taskId: string): DurableOperation[] {
    requireUuid(taskId, "Operation relation");
    return (this.database.prepare("SELECT * FROM operations WHERE operation_type = ? AND task_id = ? ORDER BY updated_at DESC, operation_id DESC").all(type, taskId) as TaskRow[]).map(rowToOperation);
  }

  loadUnfinishedOperations(): DurableOperation[] {
    return (this.database.prepare("SELECT * FROM operations WHERE state NOT IN ('persisted','failed') ORDER BY created_at, operation_id").all() as TaskRow[]).map(rowToOperation);
  }

  saveUnresolvedAgentProcess(input: UnresolvedAgentProcess) {
    requireUuid(input.executionId, "Unresolved execution ID");
    if (!( ["codex", "cursor", "claude"] as string[]).includes(input.provider) || !Number.isSafeInteger(input.pid) || input.pid < 2 || !Number.isSafeInteger(input.pgid) || input.pgid < 2 || !/^\d{1,30}$/.test(input.leaderStartTicks)) throw new Error("Unresolved agent process identity is invalid");
    if (input.runtimeBindingPath && (input.runtimeBindingPath.length > 1_000 || input.runtimeBindingPath.includes("\0"))) throw new Error("Unresolved runtime binding path is invalid");
    if (!(["UNCONFIRMED", "PROCESS_GONE_CLEANUP_PENDING", "PROCESS_GONE_CLEANED"] as string[]).includes(input.phase)) throw new Error("Unresolved agent process phase is invalid");
    this.database.prepare(`INSERT INTO unresolved_agent_processes
      (execution_id, provider, pid, pgid, leader_start_ticks, runtime_binding_path, created_at, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.executionId, input.provider, input.pid, input.pgid, input.leaderStartTicks, input.runtimeBindingPath ?? null, input.createdAt, input.phase);
  }

  loadUnresolvedAgentProcesses(): UnresolvedAgentProcess[] {
    return (this.database.prepare("SELECT * FROM unresolved_agent_processes ORDER BY created_at, execution_id").all() as TaskRow[]).map((row) => ({
      executionId: String(row.execution_id), provider: String(row.provider) as UnresolvedAgentProcess["provider"], pid: Number(row.pid), pgid: Number(row.pgid), leaderStartTicks: String(row.leader_start_ticks), runtimeBindingPath: optionalString(row.runtime_binding_path), createdAt: String(row.created_at), phase: String(row.phase) as UnresolvedAgentProcess["phase"],
    }));
  }

  updateUnresolvedAgentProcessPhase(executionId: string, phase: UnresolvedAgentProcess["phase"]) {
    requireUuid(executionId, "Unresolved execution ID");
    this.database.prepare("UPDATE unresolved_agent_processes SET phase = ? WHERE execution_id = ?").run(phase, executionId);
  }

  deleteUnresolvedAgentProcess(executionId: string) {
    requireUuid(executionId, "Unresolved execution ID");
    this.database.prepare("DELETE FROM unresolved_agent_processes WHERE execution_id = ?").run(executionId);
  }

  saveBackupMetadata(metadata: BackupMetadata) {
    requireUuid(metadata.backupId, "Backup ID");
    if (metadata.integrityStatus !== "ok" || !Number.isSafeInteger(metadata.schemaVersion) || !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1) throw new Error("Backup metadata is invalid");
    this.database.prepare(`INSERT INTO backup_metadata(backup_id, created_at, schema_version, integrity_status, size_bytes, app_commit)
      VALUES (?, ?, ?, 'ok', ?, ?)`)
      .run(metadata.backupId, metadata.createdAt, metadata.schemaVersion, metadata.sizeBytes, metadata.appCommit ?? null);
    return metadata;
  }

  loadBackups(): BackupMetadata[] {
    return (this.database.prepare("SELECT * FROM backup_metadata WHERE retired_at IS NULL ORDER BY created_at DESC").all() as TaskRow[]).map(rowToBackupMetadata);
  }

  retireBackupMetadata(backupId: string) {
    requireUuid(backupId, "Backup ID");
    this.database.prepare("UPDATE backup_metadata SET retired_at = ? WHERE backup_id = ? AND retired_at IS NULL").run(new Date().toISOString(), backupId);
  }

  loadRetentionPolicy(): RetentionPreset {
    const row = this.database.prepare("SELECT preset FROM retention_policy WHERE singleton = 1").get() as { preset?: string } | undefined;
    return row && retentionPresets.includes(row.preset as RetentionPreset) ? row.preset as RetentionPreset : "conservative";
  }

  saveRetentionPolicy(preset: RetentionPreset) {
    if (!retentionPresets.includes(preset)) throw new Error("Retention preset is invalid");
    this.database.prepare("INSERT INTO retention_policy(singleton, preset, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET preset = excluded.preset, updated_at = excluded.updated_at").run(preset, new Date().toISOString());
    this.appendCleanupAudit("retention_policy_changed", { preset });
    return preset;
  }

  appendCleanupAudit(eventType: "retention_policy_changed" | "cleanup_preview_created" | "cleanup_requested" | "cleanup_completed" | "cleanup_blocked" | "cleanup_reconcile_required", metadata: SafeOperationMetadata = {}) {
    this.database.prepare("INSERT INTO cleanup_audit_events(event_id, event_type, created_at, metadata_json) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), eventType, new Date().toISOString(), JSON.stringify(safeOperationMetadata(metadata)));
  }

  loadWatchRuleState(subjectType: "task" | "finding", subjectId: string, ruleType: NotificationType) {
    const row = this.database.prepare("SELECT last_state, last_notified_key, updated_at FROM watch_rule_state WHERE subject_type = ? AND subject_id = ? AND rule_type = ?").get(subjectType, subjectId, ruleType) as TaskRow | undefined;
    return row ? { lastState: String(row.last_state), lastNotifiedKey: optionalString(row.last_notified_key), updatedAt: String(row.updated_at) } : undefined;
  }

  saveWatchRuleState(subjectType: "task" | "finding", subjectId: string, ruleType: NotificationType, lastState: "active" | "inactive", lastNotifiedKey?: string) {
    this.database.prepare(`INSERT INTO watch_rule_state(subject_type, subject_id, rule_type, last_state, last_notified_key, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_type, subject_id, rule_type) DO UPDATE SET last_state = excluded.last_state, last_notified_key = excluded.last_notified_key, updated_at = excluded.updated_at`)
      .run(subjectType, subjectId, ruleType, lastState, lastNotifiedKey ?? null, new Date().toISOString());
  }

  loadNotificationAuditEvents() {
    return this.database.prepare("SELECT event_type, notification_id, notification_type, created_at FROM notification_audit_events ORDER BY sequence").all();
  }

  loadNotification(notificationId: string): AppNotification | undefined {
    const row = this.database.prepare("SELECT * FROM notifications WHERE notification_id = ?").get(notificationId) as TaskRow | undefined;
    return row ? rowToNotification(row) : undefined;
  }

  private appendNotificationAudit(eventType: "notification_created" | "notification_read" | "notification_dismissed" | "notification_preferences_updated", notificationId?: string, notificationType?: NotificationType) {
    this.database.prepare("INSERT INTO notification_audit_events(event_id, event_type, notification_id, notification_type, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), eventType, notificationId ?? null, notificationType ?? null, new Date().toISOString());
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
    `).run(id, taskId, step.id, version, step.agent, createdAt, bounded(redactKnownSecrets(step.output), MAX_STORED_OUTPUT_CHARS), step.status, step.durationMs ?? null);
    return { id, taskId, stepId: step.id, version, agent: step.agent, createdAt, output: bounded(redactKnownSecrets(step.output), MAX_STORED_OUTPUT_CHARS), status: step.status, durationMs: step.durationMs } satisfies StepVersion;
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

  createFindings(findings: Finding[]) {
    const insert = this.database.prepare(`
      INSERT INTO findings (finding_id, source_task_id, title, summary, severity, category, affected_paths_json, evidence, status, human_priority, created_at, updated_at, converted_task_id, resolved_at, resolved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const finding of findings) insert.run(
      finding.findingId, finding.sourceTaskId, finding.title, finding.summary, finding.severity,
      finding.category ?? null, finding.affectedPaths ? JSON.stringify(finding.affectedPaths) : null,
      finding.evidence ?? null, finding.status, finding.humanPriority ?? "normal", finding.createdAt, finding.updatedAt,
      finding.convertedTaskId ?? null, finding.resolvedAt ?? null, finding.resolvedBy ?? null,
    );
  }

  loadFindings(sourceTaskId: string): Finding[] {
    return redactKnownSecretsInValue((this.database.prepare("SELECT * FROM findings WHERE source_task_id = ? ORDER BY created_at, finding_id").all(sourceTaskId) as TaskRow[]).map(rowToFinding));
  }

  loadFinding(findingId: string): Finding | undefined {
    const row = this.database.prepare("SELECT * FROM findings WHERE finding_id = ?").get(findingId) as TaskRow | undefined;
    return row ? redactKnownSecretsInValue(rowToFinding(row)) : undefined;
  }

  updateFindingStatus(findingId: string, expected: readonly Finding["status"][], status: Finding["status"], convertedTaskId?: string) {
    const placeholders = expected.map(() => "?").join(",");
    const result = this.database.prepare(`UPDATE findings SET status = ?, converted_task_id = ?, updated_at = ? WHERE finding_id = ? AND status IN (${placeholders})`)
      .run(status, convertedTaskId ?? null, new Date().toISOString(), findingId, ...expected);
    if (Number(result.changes) !== 1) throw new Error("Finding status transition is not allowed");
    return this.loadFinding(findingId)!;
  }

  updateFindingPriority(findingId: string, priority: HumanPriority) {
    const result = this.database.prepare("UPDATE findings SET human_priority = ?, updated_at = ? WHERE finding_id = ? AND resolved_at IS NULL")
      .run(priority, new Date().toISOString(), findingId);
    if (Number(result.changes) !== 1) throw new Error("Finding priority cannot be changed");
    return this.loadFinding(findingId)!;
  }

  resolveFinding(findingId: string, resolvedAt: string) {
    const result = this.database.prepare("UPDATE findings SET resolved_at = ?, resolved_by = 'user', updated_at = ? WHERE finding_id = ? AND resolved_at IS NULL")
      .run(resolvedAt, resolvedAt, findingId);
    if (Number(result.changes) !== 1) throw new Error("Finding is already resolved or unavailable");
    return this.loadFinding(findingId)!;
  }

  appendFindingEvent(finding: Pick<Finding, "findingId" | "sourceTaskId">, input: { type: FindingEventType; actor: FindingEvent["actor"]; createdAt?: string; reason?: string; convertedTaskId?: string; previousHumanPriority?: HumanPriority; humanPriority?: HumanPriority }) {
    if (!findingEventTypes.includes(input.type)) throw new Error("Finding event type is invalid");
    if (!['user', 'system'].includes(input.actor)) throw new Error("Finding event actor is invalid");
    if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 1_000)) throw new Error("Finding dismissal reason is invalid");
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO finding_events (event_id, finding_id, source_task_id, event_type, actor, created_at, reason, converted_task_id, previous_human_priority, human_priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, finding.findingId, finding.sourceTaskId, input.type, input.actor, createdAt, input.reason?.trim() || null, input.convertedTaskId ?? null, input.previousHumanPriority ?? null, input.humanPriority ?? null);
    return { id, sequence: Number(result.lastInsertRowid), findingId: finding.findingId, sourceTaskId: finding.sourceTaskId, type: input.type, actor: input.actor, createdAt, reason: input.reason?.trim() || undefined, convertedTaskId: input.convertedTaskId, previousHumanPriority: input.previousHumanPriority, humanPriority: input.humanPriority } satisfies FindingEvent;
  }

  loadFindingEvents(findingId: string): FindingEvent[] {
    return (this.database.prepare("SELECT * FROM finding_events WHERE finding_id = ? ORDER BY sequence").all(findingId) as TaskRow[]).map(rowToFindingEvent);
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

  loadRepoTemplates(repoId: string): TaskTemplate[] {
    const rows = this.database.prepare("SELECT template_json FROM task_templates WHERE repo_id = ? ORDER BY template_id").all(repoId) as Array<{ template_json: string }>;
    return rows.map((row) => templateFromStored(row.template_json));
  }

  loadRepoTemplate(repoId: string, templateId: string): TaskTemplate | undefined {
    const row = this.database.prepare("SELECT template_json FROM task_templates WHERE repo_id = ? AND template_id = ?").get(repoId, templateId) as { template_json: string } | undefined;
    return row ? templateFromStored(row.template_json) : undefined;
  }

  loadRepoTemplateSettings(repoId: string): RepoTemplateSettings | undefined {
    const row = this.database.prepare("SELECT repo_id, default_template_id, updated_at FROM repo_template_settings WHERE repo_id = ?").get(repoId) as TaskRow | undefined;
    return row ? { repoId: String(row.repo_id), defaultTemplateId: String(row.default_template_id), updatedAt: String(row.updated_at) } : undefined;
  }

  createRepoTemplates(repoId: string, templates: TaskTemplate[], defaultTemplateId = "bug_fix") {
    if (templates.some((template) => template.repoId !== repoId) || !templates.some((template) => template.templateId === defaultTemplateId && template.enabled)) throw new Error("Repository task template defaults are invalid");
    this.transaction(() => {
      const insert = this.database.prepare(`INSERT INTO task_templates(repo_id, template_id, name, version, enabled, template_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const version = this.database.prepare(`INSERT INTO task_template_versions(repo_id, template_id, version, changed_at, changed_fields_json, actor, snapshot_json) VALUES (?, ?, ?, ?, ?, 'user', ?)`);
      for (const template of templates) {
        const snapshot = snapshotTemplate(template);
        insert.run(repoId, template.templateId, template.name, template.version, template.enabled ? 1 : 0, JSON.stringify(template), template.createdAt, template.updatedAt);
        version.run(repoId, template.templateId, template.version, template.createdAt, JSON.stringify(["created"]), JSON.stringify(snapshot));
      }
      const now = templates[0]?.createdAt ?? new Date().toISOString();
      this.database.prepare("INSERT INTO repo_template_settings(repo_id, default_template_id, updated_at) VALUES (?, ?, ?)").run(repoId, defaultTemplateId, now);
    });
  }

  updateTaskTemplate(template: TaskTemplate, changedFields: readonly string[]) {
    const snapshot = snapshotTemplate(template);
    this.transaction(() => {
      const result = this.database.prepare(`UPDATE task_templates SET version = ?, enabled = ?, template_json = ?, updated_at = ? WHERE repo_id = ? AND template_id = ? AND version = ?`)
        .run(template.version, template.enabled ? 1 : 0, JSON.stringify(template), template.updatedAt, template.repoId, template.templateId, template.version - 1);
      if (Number(result.changes) !== 1) throw new Error("Task template was changed concurrently; reload and retry");
      this.database.prepare(`INSERT INTO task_template_versions(repo_id, template_id, version, changed_at, changed_fields_json, actor, snapshot_json) VALUES (?, ?, ?, ?, ?, 'user', ?)`)
        .run(template.repoId, template.templateId, template.version, template.updatedAt, JSON.stringify(changedFields), JSON.stringify(snapshot));
      this.appendTemplateAudit(template.enabled ? "template_enabled" : "template_disabled", template.repoId, template.templateId, template.version);
    });
  }

  updateDefaultTemplate(repoId: string, templateId: string) {
    const template = this.loadRepoTemplate(repoId, templateId);
    if (!template?.enabled) throw new Error("Default task template must be enabled");
    const now = new Date().toISOString();
    const result = this.database.prepare("UPDATE repo_template_settings SET default_template_id = ?, updated_at = ? WHERE repo_id = ?").run(templateId, now, repoId);
    if (Number(result.changes) !== 1) throw new Error("Repository task template settings do not exist");
    this.appendTemplateAudit("default_template_changed", repoId, templateId, template.version);
    return { repoId, defaultTemplateId: templateId, updatedAt: now } satisfies RepoTemplateSettings;
  }

  loadTemplateVersions(repoId: string, templateId?: string): TaskTemplateVersion[] {
    const rows = (templateId
      ? this.database.prepare("SELECT * FROM task_template_versions WHERE repo_id = ? AND template_id = ? ORDER BY version").all(repoId, templateId)
      : this.database.prepare("SELECT * FROM task_template_versions WHERE repo_id = ? ORDER BY template_id, version").all(repoId)) as TaskRow[];
    return rows.map((row) => ({
      repoId: String(row.repo_id), templateId: String(row.template_id), version: Number(row.version), changedAt: String(row.changed_at),
      changedFields: JSON.parse(String(row.changed_fields_json)) as string[], actor: "user", snapshot: parseTemplateSnapshot(JSON.parse(String(row.snapshot_json))),
    }));
  }

  loadTemplateAuditEvents(repoId?: string) {
    const rows = (repoId
      ? this.database.prepare("SELECT * FROM template_audit_events WHERE repo_id = ? ORDER BY sequence").all(repoId)
      : this.database.prepare("SELECT * FROM template_audit_events ORDER BY sequence").all()) as TaskRow[];
    return rows.map((row) => ({ type: String(row.event_type) as TemplateAuditEventType, createdAt: String(row.created_at), actor: "user" as const, repoId: String(row.repo_id), templateId: String(row.template_id), templateVersion: Number(row.template_version), taskId: optionalString(row.task_id) }));
  }

  appendTemplateAudit(type: TemplateAuditEventType, repoId: string, templateId: string, templateVersion: number, taskId?: string) {
    if (!["template_enabled", "template_disabled", "default_template_changed", "template_snapshot_created"].includes(type)) throw new Error("Task template audit event type is invalid");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoId) || !/^[A-Za-z0-9._-]{1,100}$/.test(templateId) || !Number.isSafeInteger(templateVersion) || templateVersion < 1) throw new Error("Task template audit identity is invalid");
    this.database.prepare(`INSERT INTO template_audit_events(event_id, event_type, created_at, actor, repo_id, template_id, template_version, task_id) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`)
      .run(randomUUID(), type, new Date().toISOString(), repoId, templateId, templateVersion, taskId ?? null);
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
      bounded(redactKnownSecrets(step.output), MAX_STORED_OUTPUT_CHARS), step.error ? redactKnownSecrets(step.error) : null,
      step.durationMs ?? null, step.startedAt ?? null, step.completedAt ?? null,
      step.status === "stale" && step.error ? redactKnownSecrets(step.error) : null,
    ));
  }

  private rowToTask(row: TaskRow, steps: FlowStepRow[]): RepoTask {
    const payload = parseObject(row.payload_json);
    const parsedProfile = storedTaskProfile(row, payload);
    const parsedTemplate = storedTaskTemplate(row, payload, parsedProfile.profile);
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
      template: parsedTemplate.template,
      templateSnapshotValid: parsedTemplate.valid,
      sourceFindingId: optionalString(row.source_finding_id),
      sourceTaskId: optionalString(row.source_task_id),
      runtimeViolation: objectOrUndefined(payload.runtimeViolation) as RepoTask["runtimeViolation"],
      localClonePath: optionalString(payload.localClonePath),
      baseState: optionalString(payload.baseState) as RepoTask["baseState"],
      baseAheadCount: optionalNumber(payload.baseAheadCount),
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
    if (version < 3) version = 3;
    if (version < 4) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE task_templates (
          repo_id TEXT NOT NULL, template_id TEXT NOT NULL, name TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0), enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
          template_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(repo_id, template_id)
        );
        CREATE TABLE task_template_versions (
          repo_id TEXT NOT NULL, template_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
          changed_at TEXT NOT NULL, changed_fields_json TEXT NOT NULL,
          actor TEXT NOT NULL CHECK(actor = 'user'), snapshot_json TEXT NOT NULL,
          PRIMARY KEY(repo_id, template_id, version),
          FOREIGN KEY(repo_id, template_id) REFERENCES task_templates(repo_id, template_id)
        );
        CREATE TABLE repo_template_settings (
          repo_id TEXT PRIMARY KEY, default_template_id TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY(repo_id, default_template_id) REFERENCES task_templates(repo_id, template_id)
        );
        CREATE TABLE template_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL CHECK(event_type IN ('template_enabled', 'template_disabled', 'default_template_changed', 'template_snapshot_created')),
          created_at TEXT NOT NULL, actor TEXT NOT NULL CHECK(actor = 'user'), repo_id TEXT NOT NULL,
          template_id TEXT NOT NULL, template_version INTEGER NOT NULL CHECK(template_version > 0), task_id TEXT
        );
        ALTER TABLE tasks ADD COLUMN template_id TEXT;
        ALTER TABLE tasks ADD COLUMN template_version INTEGER;
        ALTER TABLE tasks ADD COLUMN template_snapshot_json TEXT;
      `);
      const profiles = this.database.prepare("SELECT repo_id, profile_json FROM project_profiles ORDER BY repo_id").all() as Array<{ repo_id: string; profile_json: string }>;
      for (const row of profiles) {
        const profile = parseProfileSnapshot(JSON.parse(row.profile_json));
        const templates = builtInTemplates(row.repo_id);
        this.createRepoTemplates(row.repo_id, templates);
        const legacy = mergeTemplateWithProfile(snapshotTemplate(templates.find((item) => item.templateId === "bug_fix")!), profile);
        this.database.prepare("UPDATE tasks SET template_id = ?, template_version = ?, template_snapshot_json = ? WHERE repo_id = ? AND template_id IS NULL")
          .run(legacy.templateId, legacy.version, JSON.stringify(legacy), row.repo_id);
      }
      this.database.exec(`
        INSERT INTO task_events(event_id, task_id, event_type, created_at, actor, status, metadata_json)
          SELECT lower(hex(randomblob(16))), task_id, 'template_snapshot_created', updated_at, 'system', 'created',
            json_object('templateId', template_id, 'templateVersion', template_version)
          FROM tasks WHERE template_id IS NOT NULL;
        INSERT INTO template_audit_events(event_id, event_type, created_at, actor, repo_id, template_id, template_version, task_id)
          SELECT lower(hex(randomblob(16))), 'template_snapshot_created', updated_at, 'user', repo_id, template_id, template_version, task_id
          FROM tasks WHERE template_id IS NOT NULL;
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(4, new Date().toISOString());
    });
    if (version < 4) version = 4;
    if (version < 5) this.transaction(() => {
      this.database.exec(`
        ALTER TABLE tasks ADD COLUMN source_finding_id TEXT;
        ALTER TABLE tasks ADD COLUMN source_task_id TEXT REFERENCES tasks(task_id);
        CREATE TABLE findings (
          finding_id TEXT PRIMARY KEY,
          source_task_id TEXT NOT NULL REFERENCES tasks(task_id),
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
          category TEXT,
          affected_paths_json TEXT,
          evidence TEXT,
          status TEXT NOT NULL CHECK(status IN ('open','accepted','dismissed','converted')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          converted_task_id TEXT UNIQUE REFERENCES tasks(task_id)
        );
        CREATE INDEX findings_source_task_idx ON findings(source_task_id, created_at);
        CREATE UNIQUE INDEX tasks_source_finding_unique ON tasks(source_finding_id) WHERE source_finding_id IS NOT NULL;
        CREATE TABLE finding_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          finding_id TEXT NOT NULL REFERENCES findings(finding_id),
          source_task_id TEXT NOT NULL REFERENCES tasks(task_id),
          event_type TEXT NOT NULL CHECK(event_type IN ('finding_created','finding_accepted','finding_dismissed','finding_conversion_requested','implementation_task_created')),
          actor TEXT NOT NULL CHECK(actor IN ('user','system')),
          created_at TEXT NOT NULL,
          reason TEXT,
          converted_task_id TEXT REFERENCES tasks(task_id)
        );
        CREATE INDEX finding_events_finding_order_idx ON finding_events(finding_id, sequence);
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(5, new Date().toISOString());
    });
    if (version < 5) version = 5;
    if (version < 6) this.transaction(() => {
      this.database.exec(`
        DROP TRIGGER IF EXISTS finding_events_no_update;
        DROP TRIGGER IF EXISTS finding_events_no_delete;
        ALTER TABLE findings ADD COLUMN human_priority TEXT NOT NULL DEFAULT 'normal'
          CHECK(human_priority IN ('urgent','high','normal','low'));
        ALTER TABLE findings ADD COLUMN resolved_at TEXT;
        ALTER TABLE findings ADD COLUMN resolved_by TEXT CHECK(resolved_by IS NULL OR resolved_by = 'user');
        ALTER TABLE finding_events RENAME TO finding_events_v5;
        CREATE TABLE finding_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          finding_id TEXT NOT NULL REFERENCES findings(finding_id),
          source_task_id TEXT NOT NULL REFERENCES tasks(task_id),
          event_type TEXT NOT NULL CHECK(event_type IN ('finding_created','finding_accepted','finding_dismissed','finding_conversion_requested','implementation_task_created','finding_priority_changed','finding_resolved')),
          actor TEXT NOT NULL CHECK(actor IN ('user','system')),
          created_at TEXT NOT NULL,
          reason TEXT,
          converted_task_id TEXT REFERENCES tasks(task_id),
          previous_human_priority TEXT CHECK(previous_human_priority IS NULL OR previous_human_priority IN ('urgent','high','normal','low')),
          human_priority TEXT CHECK(human_priority IS NULL OR human_priority IN ('urgent','high','normal','low'))
        );
        INSERT INTO finding_events(sequence, event_id, finding_id, source_task_id, event_type, actor, created_at, reason, converted_task_id)
          SELECT sequence, event_id, finding_id, source_task_id, event_type, actor, created_at, reason, converted_task_id FROM finding_events_v5;
        DROP TABLE finding_events_v5;
        CREATE INDEX finding_events_finding_order_idx ON finding_events(finding_id, sequence);
        CREATE INDEX findings_status_idx ON findings(status);
        CREATE INDEX findings_severity_idx ON findings(severity);
        CREATE INDEX findings_human_priority_idx ON findings(human_priority);
        CREATE INDEX findings_created_at_idx ON findings(created_at);
        CREATE INDEX findings_converted_task_idx ON findings(converted_task_id);
        CREATE INDEX findings_resolved_at_idx ON findings(resolved_at);
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(6, new Date().toISOString());
    });
    if (version < 6) version = 6;
    if (version < 7) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE notifications (
          notification_id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('finding_critical_created','finding_high_created','task_needs_attention','task_ready_for_approval','pr_changes_requested','ci_failed','pr_ready_for_human_merge','task_inactive','worktree_orphaned','approval_invalidated')),
          severity TEXT NOT NULL CHECK(severity IN ('info','warning','high','critical')),
          repo_id TEXT, repo_name TEXT, task_id TEXT REFERENCES tasks(task_id), finding_id TEXT REFERENCES findings(finding_id), pr_number INTEGER CHECK(pr_number IS NULL OR pr_number > 0),
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120), message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 240),
          status TEXT NOT NULL CHECK(status IN ('unread','read','dismissed')), dedupe_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL, read_at TEXT, dismissed_at TEXT
        );
        CREATE INDEX notifications_status_created_idx ON notifications(status, created_at DESC);
        CREATE INDEX notifications_repo_created_idx ON notifications(repo_id, created_at DESC);
        CREATE TABLE notification_preferences (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)), updated_at TEXT NOT NULL
        );
        CREATE TABLE watch_rule_state (
          subject_type TEXT NOT NULL CHECK(subject_type IN ('task','finding')), subject_id TEXT NOT NULL, rule_type TEXT NOT NULL,
          last_state TEXT NOT NULL CHECK(last_state IN ('active','inactive')), last_notified_key TEXT, updated_at TEXT NOT NULL,
          PRIMARY KEY(subject_type, subject_id, rule_type)
        );
        CREATE TABLE notification_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL CHECK(event_type IN ('notification_created','notification_read','notification_dismissed','notification_preferences_updated')),
          notification_id TEXT, notification_type TEXT, created_at TEXT NOT NULL
        );
      `);
      this.database.prepare("INSERT INTO notification_preferences(singleton, preferences_json, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(defaultNotificationPreferences), new Date().toISOString());
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(7, new Date().toISOString());
    });
    if (version < 7) version = 7;
    if (version < 8) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE outbound_channel_settings (
          channel TEXT PRIMARY KEY CHECK(channel = 'slack'),
          settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE notification_deliveries (
          notification_id TEXT NOT NULL REFERENCES notifications(notification_id),
          channel TEXT NOT NULL CHECK(channel = 'slack'),
          status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','suppressed')),
          attempted_at TEXT,
          delivered_at TEXT,
          error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
          PRIMARY KEY(notification_id, channel)
        );
        CREATE INDEX notification_deliveries_status_idx ON notification_deliveries(status);
        CREATE TABLE outbound_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL CHECK(event_type IN ('outbound_delivery_attempted','outbound_delivery_succeeded','outbound_delivery_failed','outbound_delivery_retried','outbound_preferences_updated')),
          notification_id TEXT,
          channel TEXT NOT NULL CHECK(channel = 'slack'),
          status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','suppressed')),
          created_at TEXT NOT NULL
        );
      `);
      this.database.prepare("INSERT INTO outbound_channel_settings(channel, settings_json, updated_at) VALUES ('slack', ?, ?)")
        .run(JSON.stringify(defaultOutboundChannelConfig), new Date().toISOString());
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(8, new Date().toISOString());
    });
    if (version < 8) version = 8;
    if (version < 9) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE credential_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL CHECK(event_type IN ('credential_resolution_failed','credential_status_checked')),
          capability TEXT NOT NULL CHECK(capability IN ('slack_outbound','github_cli','agent_codex','agent_cursor','agent_claude')),
          status TEXT NOT NULL CHECK(status IN ('configured','not_configured','externally_managed','unavailable')),
          created_at TEXT NOT NULL
        );
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(9, new Date().toISOString());
    });
    if (version < 9) version = 9;
    if (version < 10) this.transaction(() => {
      this.database.exec(`
        DROP TRIGGER IF EXISTS outbound_audit_events_no_update;
        DROP TRIGGER IF EXISTS outbound_audit_events_no_delete;
        ALTER TABLE notification_deliveries RENAME TO notification_deliveries_v9;
        CREATE TABLE notification_deliveries (
          notification_id TEXT NOT NULL REFERENCES notifications(notification_id),
          channel TEXT NOT NULL CHECK(channel = 'slack'),
          status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','suppressed','ambiguous')),
          attempted_at TEXT, delivered_at TEXT,
          error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
          attempt_id TEXT, started_at TEXT, lease_expires_at TEXT,
          PRIMARY KEY(notification_id, channel)
        );
        INSERT INTO notification_deliveries(notification_id, channel, status, attempted_at, delivered_at, error_code)
          SELECT notification_id, channel, CASE WHEN status = 'pending' THEN 'ambiguous' ELSE status END, attempted_at, delivered_at,
            CASE WHEN status = 'pending' THEN 'delivery_outcome_unknown' ELSE error_code END FROM notification_deliveries_v9;
        DROP TABLE notification_deliveries_v9;
        CREATE INDEX notification_deliveries_status_idx ON notification_deliveries(status);

        ALTER TABLE outbound_audit_events RENAME TO outbound_audit_events_v9;
        CREATE TABLE outbound_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL CHECK(event_type IN ('outbound_delivery_attempted','outbound_delivery_succeeded','outbound_delivery_failed','outbound_delivery_retried','outbound_preferences_updated','outbound_delivery_ambiguous','outbound_delivery_marked_delivered','outbound_delivery_dismissed')),
          notification_id TEXT,
          channel TEXT NOT NULL CHECK(channel = 'slack'),
          status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','suppressed','ambiguous')),
          created_at TEXT NOT NULL
        );
        INSERT INTO outbound_audit_events(sequence, event_id, event_type, notification_id, channel, status, created_at)
          SELECT sequence, event_id, event_type, notification_id, channel, status, created_at FROM outbound_audit_events_v9;
        DROP TABLE outbound_audit_events_v9;

        CREATE TABLE IF NOT EXISTS operations (
          operation_id TEXT PRIMARY KEY,
          operation_type TEXT NOT NULL CHECK(operation_type IN ('worktree_create','finding_conversion','git_commit','git_push','pr_create','slack_delivery')),
          task_id TEXT, finding_id TEXT, notification_id TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('prepared','executing','external_succeeded','persisted','reconcile_required','failed')),
          safe_metadata_json TEXT NOT NULL CHECK(json_valid(safe_metadata_json)),
          error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operations_state_idx ON operations(state, created_at);
        CREATE INDEX IF NOT EXISTS operations_task_idx ON operations(task_id, created_at);

        CREATE TABLE IF NOT EXISTS backup_metadata (
          backup_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL CHECK(schema_version > 0),
          integrity_status TEXT NOT NULL CHECK(integrity_status = 'ok'),
          size_bytes INTEGER NOT NULL CHECK(size_bytes > 0), app_commit TEXT
        );
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(10, new Date().toISOString());
    });
    if (version < 10) version = 10;
    if (version < 11) this.transaction(() => {
      const backupColumns = this.database.prepare("PRAGMA table_info(backup_metadata)").all() as Array<{ name: string }>;
      const hasRetiredAt = backupColumns.some((column) => column.name === "retired_at");
      this.database.exec(`
        DROP TRIGGER IF EXISTS backup_metadata_no_update;
        DROP TRIGGER IF EXISTS backup_metadata_no_delete;
        ${hasRetiredAt ? "" : "ALTER TABLE backup_metadata ADD COLUMN retired_at TEXT;"}
        CREATE TABLE IF NOT EXISTS retention_policy (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          preset TEXT NOT NULL CHECK(preset IN ('conservative','balanced')),
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO retention_policy(singleton, preset, updated_at) VALUES (1, 'conservative', datetime('now'));
        CREATE TABLE IF NOT EXISTS cleanup_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL CHECK(event_type IN ('retention_policy_changed','cleanup_preview_created','cleanup_requested','cleanup_completed','cleanup_blocked','cleanup_reconcile_required')),
          created_at TEXT NOT NULL, metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
        );
        ALTER TABLE operations RENAME TO operations_v10;
        CREATE TABLE operations (
          operation_id TEXT PRIMARY KEY,
          operation_type TEXT NOT NULL CHECK(operation_type IN ('worktree_create','finding_conversion','git_commit','git_push','pr_create','slack_delivery','cleanup_worktree','cleanup_node_modules','cleanup_backup','cleanup_notifications')),
          task_id TEXT, finding_id TEXT, notification_id TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('prepared','executing','external_succeeded','persisted','reconcile_required','failed')),
          safe_metadata_json TEXT NOT NULL CHECK(json_valid(safe_metadata_json)),
          error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO operations SELECT * FROM operations_v10;
        DROP TABLE operations_v10;
        CREATE INDEX operations_state_idx ON operations(state, created_at);
        CREATE INDEX operations_task_idx ON operations(task_id, created_at);
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(11, new Date().toISOString());
    });
    if (version < 11) version = 11;
    if (version < 12) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS provider_compatibility_snapshots (
          snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL CHECK(provider IN ('codex','cursor','claude')),
          version TEXT, status TEXT NOT NULL CHECK(status IN ('supported','supported_with_warning','unsupported_version','missing','credential_unavailable','sandbox_incompatible','flag_incompatible','launch_failed')),
          flags_compatible INTEGER NOT NULL CHECK(flags_compatible IN (0,1)),
          credential_status TEXT NOT NULL CHECK(credential_status IN ('available','missing','unsafe_permissions','unsupported_layout')),
          sandbox_compatible INTEGER NOT NULL CHECK(sandbox_compatible IN (0,1)), launch_compatible INTEGER NOT NULL CHECK(launch_compatible IN (0,1)),
          checked_at TEXT NOT NULL, identity TEXT
        );
        CREATE INDEX IF NOT EXISTS provider_compatibility_provider_checked_idx ON provider_compatibility_snapshots(provider, snapshot_id DESC);
        CREATE TABLE IF NOT EXISTS provider_compatibility_acknowledgements (
          provider TEXT PRIMARY KEY CHECK(provider IN ('codex','cursor','claude')), version TEXT NOT NULL, acknowledged_at TEXT NOT NULL
        );
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(12, new Date().toISOString());
    });
    if (version < 12) version = 12;
    if (version < 13) this.transaction(() => {
      this.database.exec(`
        ALTER TABLE provider_compatibility_snapshots RENAME TO provider_compatibility_snapshots_v12;
        CREATE TABLE provider_compatibility_snapshots (
          snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL CHECK(provider IN ('codex','cursor','claude')),
          version TEXT, status TEXT NOT NULL CHECK(status IN ('supported','supported_with_warning','version_probe_failed','unsupported_version','missing','credential_unavailable','sandbox_incompatible','flag_incompatible','launch_failed')),
          flags_compatible INTEGER NOT NULL CHECK(flags_compatible IN (0,1)),
          credential_status TEXT NOT NULL CHECK(credential_status IN ('available','missing','unsafe_permissions','unsupported_layout')),
          sandbox_compatible INTEGER NOT NULL CHECK(sandbox_compatible IN (0,1)), launch_compatible INTEGER NOT NULL CHECK(launch_compatible IN (0,1)),
          checked_at TEXT NOT NULL, identity TEXT
        );
        INSERT INTO provider_compatibility_snapshots SELECT * FROM provider_compatibility_snapshots_v12;
        DROP TABLE provider_compatibility_snapshots_v12;
        CREATE INDEX provider_compatibility_provider_checked_idx ON provider_compatibility_snapshots(provider, snapshot_id DESC);
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(13, new Date().toISOString());
    });
    if (version < 13) version = 13;
    if (version < 14) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS unresolved_agent_processes (
          execution_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK(provider IN ('codex','cursor','claude')),
          pid INTEGER NOT NULL CHECK(pid > 1),
          pgid INTEGER NOT NULL CHECK(pgid > 1),
          leader_start_ticks TEXT NOT NULL,
          runtime_binding_path TEXT,
          created_at TEXT NOT NULL
        );
      `);
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(14, new Date().toISOString());
    });
    if (version < 15) this.transaction(() => {
      // Some compatibility fixtures retain a table from a newer schema while
      // replaying an older schema_version chain. Make this migration
      // idempotent without weakening the on-disk phase contract.
      const hasPhase = (this.database.prepare("PRAGMA table_info(unresolved_agent_processes)").all() as TaskRow[]).some((column) => String(column.name) === "phase");
      if (!hasPhase) this.database.exec("ALTER TABLE unresolved_agent_processes ADD COLUMN phase TEXT NOT NULL DEFAULT 'UNCONFIRMED' CHECK(phase IN ('UNCONFIRMED','PROCESS_GONE_CLEANUP_PENDING','PROCESS_GONE_CLEANED'));");
      this.database.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(15, new Date().toISOString());
    });
    this.createAppendOnlyTriggers();
  }

  private createAppendOnlyTriggers() {
    for (const table of ["task_events", "step_versions", "diff_versions", "approval_events", "project_profile_versions", "profile_audit_events", "task_template_versions", "template_audit_events", "finding_events", "notification_audit_events", "outbound_audit_events", "credential_audit_events", "cleanup_audit_events"]) {
      this.database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      `);
    }
  }

  private dropAppendOnlyTriggers() {
    for (const table of ["task_events", "step_versions", "diff_versions", "approval_events", "project_profile_versions", "profile_audit_events", "task_template_versions", "template_audit_events", "finding_events", "notification_audit_events", "outbound_audit_events", "credential_audit_events", "cleanup_audit_events"]) {
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
function templateFromStored(value: unknown): TaskTemplate {
  const parsed = parseObject(value);
  if (typeof parsed.createdAt !== "string" || typeof parsed.updatedAt !== "string") throw new Error("Stored task template timestamps are invalid");
  const { createdAt, updatedAt, ...rawSnapshot } = parsed;
  const snapshot = parseTemplateSnapshot(rawSnapshot);
  return { ...snapshot, createdAt, updatedAt };
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
function storedTaskTemplate(row: TaskRow, payload: Record<string, unknown>, profile: ProjectProfileSnapshot): { template: TaskTemplateSnapshot; valid: boolean } {
  const raw = row.template_snapshot_json ?? payload.templateSnapshot;
  try {
    const template = parseTemplateSnapshot(typeof raw === "string" ? JSON.parse(raw) : raw);
    const valid = template.repoId === String(row.repo_id)
      && template.templateId === String(row.template_id)
      && template.version === Number(row.template_version);
    return { template, valid };
  } catch {
    const fallback = mergeTemplateWithProfile(snapshotTemplate(builtInTemplates(String(row.repo_id))[0]), profile);
    return { template: fallback, valid: false };
  }
}
const metadataKeys = new Set(["durationMs", "diffHash", "commitSha", "prNumber", "changedFileCount", "additions", "deletions", "profileId", "profileVersion", "templateId", "templateVersion", "findingId", "sourceTaskId", "agent", "role", "policyClass", "runtimePolicyVersion", "violationType", "sandboxProfile", "capabilityClass", "failureCode", "lifecycle"]);
function validateMetadata(value: TaskEventMetadata | undefined) {
  if (!value) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (!metadataKeys.has(key)) throw new Error(`Task event metadata key ${JSON.stringify(key)} is forbidden`);
    if (item === undefined) continue;
    if (key === "lifecycle") { validateLifecycleTelemetry(item); continue; }
    if (["durationMs", "changedFileCount", "additions", "deletions"].includes(key) && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "prNumber" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "diffHash" && (typeof item !== "string" || !/^[0-9a-f]{64}$/i.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "commitSha" && (typeof item !== "string" || !/^[0-9a-f]{40,64}$/i.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "profileId" && (typeof item !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "profileVersion" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "templateId" && (typeof item !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "templateVersion" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (["findingId", "sourceTaskId"].includes(key) && (typeof item !== "string" || !/^[0-9a-f-]{36}$/i.test(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "agent" && !["codex", "cursor", "claude"].includes(String(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "role" && !["implement", "review_only", "disabled"].includes(String(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "policyClass" && !["repository_implementation", "repository_review", "generic_read_only", "disabled"].includes(String(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "runtimePolicyVersion" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1)) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "violationType" && !["unexpected_write", "head_changed", "branch_changed", "base_repo_changed", "worktree_escape", "unexpected_worktree", "forbidden_runtime_configuration"].includes(String(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "sandboxProfile" && !["agent_read_only", "agent_implement", "validation"].includes(String(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "capabilityClass" && !["repository_implementation", "repository_review", "generic_read_only", "disabled", "validation"].includes(String(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
    if (key === "failureCode" && !["backend_missing", "backend_not_executable", "namespace_unsupported", "invalid_sandbox_configuration", "sandbox_launch_failed"].includes(String(item))) throw new Error(`Task event metadata value for ${JSON.stringify(key)} is invalid`);
  }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as TaskEventMetadata;
}

const lifecycleKeys = new Set(["spawnedAt", "timeoutRequestedAt", "sigtermRequestedAt", "sigtermSentAt", "sigkillRequestedAt", "sigkillSentAt", "childClosedAt", "exitCode", "exitSignal", "stdoutBytes", "stderrBytes", "stdoutFirstByteAt", "stdoutLastByteAt", "stderrFirstByteAt", "stderrLastByteAt", "terminationMethod", "terminationReason"]);
const lifecycleTimestampKeys = new Set(["spawnedAt", "timeoutRequestedAt", "sigtermRequestedAt", "sigtermSentAt", "sigkillRequestedAt", "sigkillSentAt", "childClosedAt", "stdoutFirstByteAt", "stdoutLastByteAt", "stderrFirstByteAt", "stderrLastByteAt"]);
const lifecycleIntegerKeys = new Set(["exitCode", "stdoutBytes", "stderrBytes"]);
const lifecycleSignals = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR", "SIGSYS"]);
function validateLifecycleTelemetry(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task lifecycle telemetry is invalid");
  const telemetry = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(telemetry)) {
    if (!lifecycleKeys.has(key) || item === undefined) throw new Error("Task lifecycle telemetry field is forbidden");
    if (lifecycleTimestampKeys.has(key) && (typeof item !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) || Number.isNaN(Date.parse(item)))) throw new Error("Task lifecycle timestamp is invalid");
    if (lifecycleIntegerKeys.has(key) && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) throw new Error("Task lifecycle count is invalid");
    if (key === "exitSignal" && (typeof item !== "string" || !lifecycleSignals.has(item))) throw new Error("Task lifecycle signal is invalid");
    if (key === "terminationMethod" && item !== "term_only" && item !== "kill_required") throw new Error("Task lifecycle termination method is invalid");
    if (key === "terminationReason" && item !== "agent_deadline_exceeded" && item !== "request_aborted" && item !== "flow_aborted" && item !== "step_budget_exhausted") throw new Error("Task lifecycle termination reason is invalid");
  }
  if (typeof telemetry.spawnedAt !== "string" || typeof telemetry.stdoutBytes !== "number" || typeof telemetry.stderrBytes !== "number") throw new Error("Task lifecycle telemetry is incomplete");
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
function rowToFinding(row: TaskRow): Finding {
  const affectedPaths = row.affected_paths_json === null || row.affected_paths_json === undefined ? undefined : array(parseJson(row.affected_paths_json)).filter((item): item is string => typeof item === "string");
  return {
    findingId: String(row.finding_id), sourceTaskId: String(row.source_task_id), title: String(row.title), summary: String(row.summary),
    severity: String(row.severity) as Finding["severity"], category: optionalString(row.category), affectedPaths,
    evidence: optionalString(row.evidence), status: String(row.status) as Finding["status"],
    humanPriority: (optionalString(row.human_priority) ?? "normal") as Finding["humanPriority"], createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), convertedTaskId: optionalString(row.converted_task_id),
    resolvedAt: optionalString(row.resolved_at), resolvedBy: optionalString(row.resolved_by) as Finding["resolvedBy"],
  };
}
function rowToFindingEvent(row: TaskRow): FindingEvent {
  return {
    id: String(row.event_id), sequence: Number(row.sequence), findingId: String(row.finding_id), sourceTaskId: String(row.source_task_id),
    type: String(row.event_type) as FindingEventType, actor: String(row.actor) as FindingEvent["actor"], createdAt: String(row.created_at),
    reason: optionalString(row.reason), convertedTaskId: optionalString(row.converted_task_id),
    previousHumanPriority: optionalString(row.previous_human_priority) as FindingEvent["previousHumanPriority"],
    humanPriority: optionalString(row.human_priority) as FindingEvent["humanPriority"],
  };
}
function rowToNotification(row: TaskRow): AppNotification {
  return {
    notificationId: String(row.notification_id), type: String(row.type) as NotificationType,
    severity: String(row.severity) as NotificationSeverity, repoId: optionalString(row.repo_id),
    repoName: optionalString(row.repo_name), taskId: optionalString(row.task_id), findingId: optionalString(row.finding_id),
    prNumber: optionalNumber(row.pr_number), title: String(row.title), message: String(row.message),
    status: String(row.status) as AppNotification["status"], dedupeKey: String(row.dedupe_key),
    createdAt: String(row.created_at), readAt: optionalString(row.read_at), dismissedAt: optionalString(row.dismissed_at),
  };
}
function rowToNotificationDelivery(row: TaskRow): NotificationDelivery {
  return {
    notificationId: String(row.notification_id), channel: "slack", status: String(row.status) as DeliveryStatus,
    attemptedAt: optionalString(row.attempted_at), deliveredAt: optionalString(row.delivered_at), errorCode: optionalString(row.error_code),
    attemptId: optionalString(row.attempt_id), startedAt: optionalString(row.started_at), leaseExpiresAt: optionalString(row.lease_expires_at),
  };
}
function rowToOperation(row: TaskRow): DurableOperation {
  return {
    operationId: String(row.operation_id), type: String(row.operation_type) as OperationType,
    taskId: optionalString(row.task_id), findingId: optionalString(row.finding_id), notificationId: optionalString(row.notification_id),
    idempotencyKey: String(row.idempotency_key), state: String(row.state) as OperationState,
    safeMetadata: safeOperationMetadata(parseObject(row.safe_metadata_json) as SafeOperationMetadata),
    errorCode: optionalString(row.error_code), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function rowToBackupMetadata(row: TaskRow): BackupMetadata {
  return {
    backupId: String(row.backup_id), createdAt: String(row.created_at), schemaVersion: Number(row.schema_version),
    integrityStatus: "ok", sizeBytes: Number(row.size_bytes), appCommit: optionalString(row.app_commit),
  };
}
function rowToProviderCompatibility(row: TaskRow): ProviderCompatibilitySnapshot & { identity?: string } {
  return {
    provider: String(row.provider) as ProviderCompatibilitySnapshot["provider"], status: String(row.status) as ProviderCompatibilitySnapshot["status"],
    version: optionalString(row.version), flagsCompatible: Number(row.flags_compatible) === 1,
    credentialStatus: String(row.credential_status) as ProviderCompatibilitySnapshot["credentialStatus"], sandboxCompatible: Number(row.sandbox_compatible) === 1,
    launchCompatible: Number(row.launch_compatible) === 1, checkedAt: String(row.checked_at), versionChanged: false, identityChanged: false, identity: optionalString(row.identity),
  };
}
function requireUuid(value: string, label: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`${label} is invalid`);
}
function boundedErrorCode(value: string | undefined) {
  if (value === undefined) return undefined;
  return /^[a-z0-9_-]{1,80}$/.test(value) ? value : "unknown";
}
function safeOperationMetadata(value: SafeOperationMetadata): SafeOperationMetadata {
  const safe: SafeOperationMetadata = {};
  const forbidden = /(?:prompt|output|secret|token|credential|password|cookie|authorization|webhook)/i;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || forbidden.test(key)) throw new Error("Operation metadata key is forbidden");
    if (item === undefined) continue;
    if (typeof item === "string") {
      if (item.length > 500 || containsSensitiveOperationValue(item)) throw new Error("Operation metadata value is unsafe");
      safe[key] = redactKnownSecrets(item);
    } else if (typeof item === "number" && Number.isSafeInteger(item)) safe[key] = item;
    else if (typeof item === "boolean") safe[key] = item;
    else throw new Error("Operation metadata value is invalid");
  }
  return safe;
}
function containsSensitiveOperationValue(value: string) {
  return /(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|hooks\.slack\.com\/services\/)/i.test(value);
}
function parseJson(value: unknown): unknown { try { return JSON.parse(String(value)); } catch { return undefined; } }
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
    templateId: optionalString(row.template_id), templateVersion: optionalNumber(row.template_version),
    sourceFindingId: optionalString(row.source_finding_id), sourceTaskId: optionalString(row.source_task_id),
  };
}

function rowToRemediationQueueItem(row: TaskRow, now: Date): RemediationQueueItem {
  const stage = String(row.remediation_stage) as RemediationQueueItem["remediationStage"];
  const status = optionalString(row.implementation_task_status);
  const prNumber = optionalNumber(row.pr_number);
  const rawPrUrl = optionalString(row.pr_url);
  const originUrl = optionalString(row.implementation_origin_url) ?? optionalString(row.source_origin_url);
  const prUrl = validatedStoredPrUrl(originUrl, prNumber, rawPrUrl);
  const createdAt = String(row.created_at);
  return {
    findingId: String(row.finding_id), title: String(row.title), category: optionalString(row.category),
    affectedPaths: row.affected_paths_json === null || row.affected_paths_json === undefined
      ? undefined : array(parseJson(row.affected_paths_json)).filter((item): item is string => typeof item === "string"),
    severity: String(row.severity) as Finding["severity"], humanPriority: String(row.human_priority) as HumanPriority,
    repoId: optionalString(row.repo_id) ?? "", repoName: optionalString(row.repo_name) ?? "Missing source task",
    sourceTaskId: String(row.source_task_id), sourceTemplateName: optionalString(row.source_template_name),
    sourceTemplateVersion: optionalNumber(row.source_template_version), findingStatus: String(row.status) as Finding["status"],
    remediationStage: stage, implementationTaskId: optionalString(row.implementation_task_id), implementationTaskStatus: status,
    prNumber, prUrl, prState: optionalString(row.pr_state), mergeReadiness: optionalString(row.merge_readiness),
    createdAt, updatedAt: String(row.updated_at), ageMs: Math.max(0, now.getTime() - Date.parse(createdAt)),
    nextAction: remediationNextAction(stage, status), attentionReason: remediationAttentionReason(row, stage),
    resolvedAt: optionalString(row.resolved_at), resolvedBy: optionalString(row.resolved_by) as Finding["resolvedBy"],
  };
}

function remediationNextAction(stage: RemediationStage, taskStatus?: string): RemediationQueueItem["nextAction"] {
  if (stage === "untriaged") return "accept_or_dismiss";
  if (stage === "accepted" || stage === "implementation_not_created") return "create_implementation_task";
  if (stage === "needs_attention") return "manual_recovery";
  if (stage === "awaiting_approval") return "review_diff";
  if (stage === "ready_for_human_merge") return "human_merge";
  if (stage === "resolved_candidate") return "mark_resolved";
  if (stage === "pr_open") return taskStatus === "pr_failed" ? "open_pr" : "fetch_pr_review";
  if (stage === "implementation_active") return taskStatus === "reviewed" ? "review_diff" : "resume_implementation";
  return "none";
}

function remediationAttentionReason(row: TaskRow, stage: RemediationStage): string | undefined {
  if (stage !== "needs_attention") return undefined;
  if (!row.repo_id) return "The source task is missing.";
  if (row.status === "converted" && !row.implementation_task_id) return "The converted implementation task is missing.";
  if (row.implementation_source_finding_id !== row.finding_id || row.implementation_source_task_id !== row.source_task_id) return "The implementation task linkage is invalid.";
  if (row.implementation_worktree_status === "missing" || row.implementation_worktree_status === "invalid") return "The implementation task worktree is unavailable.";
  return optionalString(row.implementation_recovery_message) ?? "The linked remediation state requires manual recovery.";
}

function validatedStoredPrUrl(originUrl?: string, prNumber?: number, prUrl?: string) {
  if (!originUrl || !prNumber || !prUrl) return undefined;
  const match = originUrl.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
    ?? originUrl.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const expected = match ? `https://github.com/${match[1]}/${match[2]}/pull/${prNumber}` : undefined;
  return expected === prUrl ? expected : undefined;
}
