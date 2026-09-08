import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { runGit } from "./git";
import { ALLOWED_ROOT, validateRepository } from "./repositories";
import { getStateStore, type ApprovalEvent, type TaskEventActor, type TaskEventMetadata, type TaskEventType, type TaskHistory } from "./state-store";
import type { FlowEvent, FlowStep, ReviewRerunEvent } from "../agents/types";
import { parseProfileSnapshot, safeDefaultSnapshot, type ProjectProfileSnapshot } from "../profiles/policy";
import type { PrReviewIntake, PullRequestReview, ReworkFlowResult } from "./pr-review-types";
import { getOrCreateRepoProfile, requireUsableTaskProfile, taskProfileSnapshot } from "./project-profiles";
import { selectTaskTemplate } from "./task-templates";
import { builtInTemplate, mergeTemplateWithProfile, parseTemplateSnapshot, taskExecutionPrompt, type TaskTemplateSnapshot } from "../templates/policy";
import { evaluateTaskNotifications } from "./notifications";
import { redactKnownSecrets, redactKnownSecretsInValue } from "./credential-resolver";
import type { RuntimePolicy, RuntimeViolation, RuntimeViolationRecord } from "../runtime/types";
import { runtimeViolationMessage } from "./runtime-policy";
import type { OsSandboxAudit } from "./os-sandbox";
import { acquireTaskLock, releaseTaskLock } from "./task-lock";
import { beginRegisteredOperation } from "./operation-registry";

export const WORKTREE_ROOT = join(homedir(), "code", ".multiagents-worktrees");
export const TASK_BRANCH_PATTERN = /^multiagents\/[0-9a-f-]{36}$/;

export type TaskStatus =
  | "draft"
  | "reviewed"
  | "awaiting_approval"
  | "validating"
  | "committing"
  | "pushing"
  | "creating_pr"
  | "pr_created"
  | "fetching_review"
  | "review_ready"
  | "awaiting_rework_approval"
  | "reworking"
  | "reviewing_rework"
  | "awaiting_final_approval"
  | "committing_rework"
  | "pushing_rework"
  | "checking_ci"
  | "ready_for_human_merge"
  | "review_fetch_failed"
  | "rework_failed"
  | "ci_failed"
  | "ci_pending"
  | "validation_failed"
  | "secret_scan_failed"
  | "approval_invalidated"
  | "commit_failed"
  | "push_failed"
  | "pr_failed"
  | "archived";

export type ApprovalState = "unavailable" | "pending" | "processing" | "invalidated" | "used";
export type ApprovalPurpose = "create_pr" | "rework";
export type RecoveryStatus = "recoverable" | "needs_attention" | "orphaned" | "invalid";
export type WorktreeStatus = "available" | "not_required" | "missing" | "removed" | "invalid";
export type BaseState = "base_current" | "base_advanced" | "base_diverged" | "base_missing";
export type ValidationCheck = { name: string; status: "pass" | "fail" | "skip"; detail?: string };
export type SecretFinding = { path: string; kind: "filename" | "content" | "limit"; rule: string };

export type RepoTask = {
  id: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  allowedRoot: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  baseState?: BaseState;
  baseAheadCount?: number;
  originUrl?: string;
  worktreePath: string;
  worktreeRoot: string;
  worktreeAvailable: boolean;
  status: TaskStatus;
  prompt: string;
  reviewReady: boolean;
  diffHash?: string;
  approvalId?: string;
  approvalState: ApprovalState;
  approvalPurpose?: ApprovalPurpose;
  validation: ValidationCheck[];
  secretFindings: SecretFinding[];
  commitSha?: string;
  prUrl?: string;
  prNumber?: number;
  prReview?: PullRequestReview;
  reviewIntake?: PrReviewIntake;
  reworkResult?: ReworkFlowResult;
  originalTaskAvailable: boolean;
  reworkBaseSha?: string;
  latestPushedSha?: string;
  ciMessage?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  flowId?: string;
  flowStatus?: string;
  flowSteps?: FlowStep[];
  finalOutput?: string;
  recoveryStatus: RecoveryStatus;
  recoveryMessage?: string;
  worktreeStatus: WorktreeStatus;
  profile?: ProjectProfileSnapshot;
  profileSnapshotValid?: boolean;
  template?: TaskTemplateSnapshot;
  templateSnapshotValid?: boolean;
  sourceFindingId?: string;
  sourceTaskId?: string;
  runtimeViolation?: RuntimeViolationRecord;
};

export type TaskDiff = {
  trackedFiles: string[];
  untrackedFiles: string[];
  stat: string;
  patch: string;
  untrackedPatch: string;
  truncated: boolean;
  approvable: boolean;
  blockedReason?: string;
};

export const MAX_UNTRACKED_FILE_BYTES = 100_000;
export const MAX_UNTRACKED_TOTAL_BYTES = 500_000;
const tasks = new Map<string, RepoTask>();
let tasksLoaded = false;
let recoveryPromise: Promise<void> | undefined;

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["reviewed"],
  reviewed: ["draft", "awaiting_approval"],
  awaiting_approval: ["draft", "validating"],
  validating: ["committing", "committing_rework", "validation_failed", "secret_scan_failed", "approval_invalidated"],
  committing: ["pushing", "commit_failed", "approval_invalidated"],
  pushing: ["creating_pr", "push_failed"],
  creating_pr: ["pr_created", "pr_failed"],
  pr_created: ["fetching_review"],
  fetching_review: ["review_ready", "awaiting_rework_approval", "ready_for_human_merge", "review_fetch_failed"],
  review_ready: ["fetching_review", "awaiting_rework_approval", "ready_for_human_merge"],
  awaiting_rework_approval: ["fetching_review", "reworking"],
  reworking: ["reviewing_rework", "rework_failed"],
  reviewing_rework: ["awaiting_final_approval", "rework_failed"],
  awaiting_final_approval: ["fetching_review", "validating"],
  committing_rework: ["pushing_rework", "commit_failed", "approval_invalidated"],
  pushing_rework: ["checking_ci", "push_failed"],
  checking_ci: ["review_ready", "ready_for_human_merge", "ci_failed", "ci_pending"],
  ready_for_human_merge: ["fetching_review"],
  review_fetch_failed: ["fetching_review"],
  rework_failed: ["fetching_review", "awaiting_rework_approval"],
  ci_failed: ["fetching_review"],
  ci_pending: ["fetching_review"],
  validation_failed: ["draft", "awaiting_approval", "awaiting_final_approval"],
  secret_scan_failed: ["draft", "awaiting_approval", "awaiting_final_approval"],
  approval_invalidated: ["draft", "awaiting_approval", "awaiting_final_approval"],
  commit_failed: ["draft", "awaiting_approval", "awaiting_final_approval"],
  push_failed: ["pushing", "pushing_rework", "fetching_review"],
  pr_failed: ["creating_pr"],
  archived: [],
};

export async function createTask(repoId: string, options: { allowedRoot?: string; worktreeRoot?: string; templateId?: string; prompt?: string; sourceFindingId?: string; sourceTaskId?: string } = {}): Promise<RepoTask> {
  loadPersistedTasks();
  const allowedRoot = options.allowedRoot ?? ALLOWED_ROOT;
  const repo = await validateRepository(repoId, allowedRoot);
  const profile = taskProfileSnapshot(await getOrCreateRepoProfile(repoId, allowedRoot));
  requireUsableTaskProfile(profile, repoId);
  const template = await selectTaskTemplate(repoId, options.templateId, profile, allowedRoot);
  if (options.prompt !== undefined && (typeof options.prompt !== "string" || options.prompt.length > 20_000)) throw new Error("Task prompt is invalid");
  if ((options.sourceFindingId !== undefined && !/^[0-9a-f-]{36}$/i.test(options.sourceFindingId)) || (options.sourceTaskId !== undefined && !/^[0-9a-f-]{36}$/i.test(options.sourceTaskId))) throw new Error("Task source linkage is invalid");
  if (Boolean(options.sourceFindingId) !== Boolean(options.sourceTaskId)) throw new Error("Task source linkage must include both finding and task IDs");
  if (repo.dirty && template.requireWorktree) throw new Error("Repository has uncommitted changes. Commit or stash them before creating a worktree.");
  if (template.requireWorktree) {
    const { assertWorktreeDiskCapacity } = await import("./operational-health");
    await assertWorktreeDiskCapacity({ root: options.worktreeRoot ?? WORKTREE_ROOT });
  }
  const id = randomUUID();
  const branch = `multiagents/${id}`;
  const worktreeRoot = options.worktreeRoot ?? WORKTREE_ROOT;
  const parent = join(worktreeRoot, repo.id);
  const worktreePath = join(parent, id);
  const baseSha = await runGit(repo.path, ["rev-parse", "HEAD"]);
  let originUrl: string | undefined;
  try { originUrl = await runGit(repo.path, ["remote", "get-url", "origin"]); } catch { /* approval reports a missing origin */ }
  const task: RepoTask = {
    id,
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    allowedRoot,
    branch: template.requireWorktree ? branch : repo.branch,
    baseBranch: repo.branch,
    baseSha,
    baseState: "base_current",
    baseAheadCount: 0,
    originUrl,
    worktreePath: template.requireWorktree ? worktreePath : repo.path,
    worktreeRoot,
    worktreeAvailable: false,
    status: "draft",
    prompt: options.prompt?.trim() ?? "",
    reviewReady: false,
    approvalState: "unavailable",
    originalTaskAvailable: true,
    validation: [],
    secretFindings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recoveryStatus: "recoverable",
    worktreeStatus: template.requireWorktree ? "missing" : "not_required",
    profile,
    profileSnapshotValid: true,
    template,
    templateSnapshotValid: true,
    sourceFindingId: options.sourceFindingId,
    sourceTaskId: options.sourceTaskId,
  };
  tasks.set(id, task);
  const store = getStateStore();
  let worktreeOperation: ReturnType<typeof store.createOperation> | undefined;
  store.transaction(() => {
    if (template.requireWorktree) worktreeOperation = store.createOperation({
      type: "worktree_create", taskId: id, idempotencyKey: `worktree_create:${id}`,
      safeMetadata: { repoId: repo.id, branch, baseSha },
    });
    persistTask(task);
    store.appendTaskEvent(task.id, { type: "task_created", actor: "user", createdAt: task.createdAt, status: task.status });
    store.appendTaskEvent(task.id, { type: "profile_snapshot_created", actor: "user", createdAt: task.createdAt, status: "created", metadata: { profileId: profile.profileId, profileVersion: profile.version } });
    store.appendTaskEvent(task.id, { type: "template_snapshot_created", actor: "user", createdAt: task.createdAt, status: "created", metadata: { templateId: template.templateId, templateVersion: template.version } });
    store.appendProfileAudit("profile_snapshot_created", task.repoId, profile.profileId, profile.version, task.id);
    store.appendTemplateAudit("template_snapshot_created", task.repoId, template.templateId, template.version, task.id);
  });
  if (worktreeOperation) {
    const operation = worktreeOperation;
    const endOperation = beginRegisteredOperation(operation.operationId, "worktree_create", task.id);
    try {
      store.updateOperation(operation.operationId, "executing");
      await mkdir(parent, { recursive: true });
      await runGit(repo.path, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
      store.updateOperation(operation.operationId, "external_succeeded");
      store.transaction(() => {
        task.worktreeAvailable = true;
        task.worktreeStatus = "available";
        persistTask(task);
        store.updateOperation(operation.operationId, "persisted");
      });
    } catch (error) {
      store.updateOperation(operation.operationId, "reconcile_required", undefined, "worktree_outcome_unknown");
      task.recoveryStatus = "needs_attention";
      task.recoveryMessage = "Managed worktree creation failed. The operation journal was retained for recovery.";
      persistTask(task);
      throw error;
    } finally { endOperation(); }
  }
  return task;
}

export function getTask(id: string) {
  loadPersistedTasks();
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return tasks.get(id);
}

export function listTasks() {
  loadPersistedTasks();
  return [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function transitionTask(task: RepoTask, next: TaskStatus) {
  if (task.status === next) return;
  if (!transitions[task.status].includes(next)) throw new Error(`Invalid task transition: ${task.status} -> ${next}`);
  task.status = next;
  persistTask(task);
}

export function beginTaskReview(task: RepoTask, prompt: string) {
  requireNoRuntimeViolation(task);
  const template = requireTaskTemplate(task);
  if (!template.readOnly && !task.worktreeAvailable) throw new Error("Managed task worktree is unavailable");
  if (task.commitSha || ["committing", "pushing", "creating_pr", "pr_created", "push_failed", "pr_failed"].includes(task.status)) {
    throw new Error("This task can no longer run a review flow");
  }
  if (task.status !== "draft") transitionTask(task, "draft");
  task.prompt = prompt;
  task.reviewReady = false;
  invalidateApproval(task);
  task.validation = [];
  task.secretFindings = [];
  task.error = undefined;
  task.flowSteps = [];
  task.flowStatus = "running";
  task.finalOutput = "";
  persistTask(task);
}

export function beginTaskRerun(task: RepoTask, prompt: string) {
  requireNoRuntimeViolation(task);
  const template = requireTaskTemplate(task);
  if (!template.readOnly && !task.worktreeAvailable) throw new Error("Managed task worktree is unavailable");
  if (task.commitSha || ["committing", "pushing", "creating_pr", "pr_created", "push_failed", "pr_failed"].includes(task.status)) {
    throw new Error("This task can no longer rerun a review flow");
  }
  if (task.status !== "draft") transitionTask(task, "draft");
  task.prompt = prompt;
  task.reviewReady = false;
  invalidateApproval(task);
  task.validation = [];
  task.secretFindings = [];
  task.error = undefined;
  task.flowStatus = "running";
  persistTask(task);
}

export function completeTaskReview(task: RepoTask, finalReady: boolean) {
  if (task.status !== "draft") throw new Error("Review completion is not valid in the current task state");
  transitionTask(task, "reviewed");
  task.reviewReady = finalReady;
  if (finalReady && !requireTaskTemplate(task).readOnly) transitionTask(task, "awaiting_approval");
  persistTask(task);
}

export function invalidateApproval(task: RepoTask) {
  const prior = task.approvalId && task.diffHash && task.approvalPurpose && ["pending", "processing"].includes(task.approvalState)
    ? { approvalId: task.approvalId, diffHash: task.diffHash, purpose: task.approvalPurpose }
    : undefined;
  task.diffHash = undefined;
  task.approvalId = undefined;
  task.approvalState = "unavailable";
  task.approvalPurpose = undefined;
  if (prior) recordApprovalEvent(task, "invalidated", prior, "invalidated");
}

export function registerRecoveredTask(task: RepoTask) {
  loadPersistedTasks();
  if (tasks.has(task.id)) throw new Error("Task is already registered");
  const now = new Date().toISOString();
  task.createdAt ||= now;
  task.updatedAt ||= now;
  task.recoveryStatus ||= task.worktreeAvailable ? "recoverable" : "orphaned";
  task.worktreeStatus ||= task.worktreeAvailable ? "available" : "missing";
  task.profile ??= safeDefaultSnapshot(task.repoId);
  task.profileSnapshotValid = true;
  task.template ??= mergeTemplateWithProfile(builtInTemplate(task.repoId, "bug_fix"), task.profile);
  task.templateSnapshotValid = true;
  tasks.set(task.id, task);
  const store = getStateStore();
  store.transaction(() => {
    persistTask(task);
    store.appendTaskEvent(task.id, { type: "task_created", actor: "system", createdAt: task.createdAt, status: task.status });
  });
  return task;
}

export function publicTask(task: RepoTask) {
  return redactKnownSecretsInValue({
    id: task.id,
    repoId: task.repoId,
    repoName: task.repoName,
    branch: task.branch,
    baseBranch: task.baseBranch,
    status: task.status,
    approvalState: task.approvalState,
    approvalPurpose: task.approvalPurpose,
    validation: task.validation,
    secretFindings: task.secretFindings,
    commitSha: task.commitSha,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    prReview: task.prReview,
    reviewIntake: task.reviewIntake,
    reworkResult: task.reworkResult,
    originalTaskAvailable: task.originalTaskAvailable,
    worktreeAvailable: task.worktreeAvailable,
    latestPushedSha: task.latestPushedSha,
    ciMessage: task.ciMessage,
    error: task.error,
    prompt: task.prompt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    flowId: task.flowId,
    flowStatus: task.flowStatus,
    flowSteps: task.flowSteps ?? [],
    finalOutput: task.finalOutput,
    recoveryStatus: task.recoveryStatus,
    recoveryMessage: task.recoveryMessage,
    worktreeStatus: task.worktreeStatus,
    profile: task.profile ?? safeDefaultSnapshot(task.repoId),
    template: task.template ?? mergeTemplateWithProfile(builtInTemplate(task.repoId, "bug_fix"), task.profile ?? safeDefaultSnapshot(task.repoId)),
    sourceFindingId: task.sourceFindingId,
    sourceTaskId: task.sourceTaskId,
    runtimeViolation: task.runtimeViolation,
  });
}

export function persistTask(task: RepoTask) {
  getStateStore().saveTask(task);
  evaluateTaskNotifications(task);
}

export function getTaskHistory(taskId: string): TaskHistory { return redactKnownSecretsInValue(getStateStore().loadTaskHistory(taskId)); }

export function recordTaskEvent(task: RepoTask, type: TaskEventType, actor: TaskEventActor, input: { createdAt?: string; stepId?: string; status?: string; metadata?: TaskEventMetadata } = {}) {
  return getStateStore().appendTaskEvent(task.id, { type, actor, ...input });
}

export function recordRuntimeAudit(task: RepoTask, type: Extract<TaskEventType, "runtime_policy_created" | "runtime_execution_started" | "runtime_execution_completed" | "runtime_violation_detected">, policy: RuntimePolicy, stepId?: string, violationType?: RuntimeViolation) {
  recordTaskEvent(task, type, policy.agent, {
    stepId,
    status: violationType ?? (type === "runtime_execution_started" ? "started" : type === "runtime_execution_completed" ? "completed" : "created"),
    metadata: {
      agent: policy.agent,
      role: policy.role,
      policyClass: policy.policyClass,
      runtimePolicyVersion: policy.version,
      violationType,
    },
  });
}

export function recordOsSandboxAudit(task: RepoTask, event: OsSandboxAudit, stepId?: string) {
  recordTaskEvent(task, event.type, event.provider ?? "system", {
    stepId,
    status: event.failureCode ?? (event.type === "os_sandbox_created" ? "enforced" : event.type === "os_sandbox_process_cleanup" ? "cleaned" : "blocked"),
    metadata: {
      agent: event.provider,
      sandboxProfile: event.profile,
      capabilityClass: event.capabilityClass,
      failureCode: event.failureCode,
    },
  });
}

export function markRuntimeViolation(task: RepoTask, policy: RuntimePolicy, violation: RuntimeViolation) {
  const message = runtimeViolationMessage(violation);
  task.runtimeViolation = { type: violation, agent: policy.agent, role: policy.role, policyClass: policy.policyClass, message };
  task.reviewReady = false;
  task.flowStatus = "error";
  task.error = message;
  task.recoveryStatus = "needs_attention";
  task.recoveryMessage = message;
  invalidateApproval(task);
  persistTask(task);
}

export function requireNoRuntimeViolation(task: RepoTask) {
  if (task.runtimeViolation) throw new Error(task.runtimeViolation.message);
}

export function recordApprovalEvent(
  task: RepoTask,
  type: ApprovalEvent["type"],
  approval: { approvalId: string; diffHash: string; purpose: NonNullable<RepoTask["approvalPurpose"]> },
  status?: string,
) {
  const store = getStateStore();
  return store.transaction(() => {
    persistTask(task);
    const event = store.appendApprovalEvent(task.id, { type, ...approval, status });
    const taskType = type === "issued" ? "approval_issued" : type === "invalidated" ? "approval_invalidated" : type === "accepted" ? "approval_accepted" : "approval_failed";
    store.appendTaskEvent(task.id, { type: taskType, actor: type === "accepted" ? "user" : "system", createdAt: event.createdAt, status, metadata: { diffHash: approval.diffHash } });
    return event;
  });
}

export function recordDiffVersion(task: RepoTask, diffHash: string, diff: TaskDiff) {
  const changedFiles = new Set([...diff.trackedFiles, ...diff.untrackedFiles]);
  let additions = 0;
  let deletions = 0;
  for (const line of `${diff.patch}\n${diff.untrackedPatch}`.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  const store = getStateStore();
  return store.transaction(() => {
    const version = store.appendDiffVersion(task.id, { diffHash, changedFileCount: changedFiles.size, additions, deletions });
    if (version) store.appendTaskEvent(task.id, { type: "diff_generated", actor: "system", createdAt: version.createdAt, status: "generated", metadata: { diffHash, changedFileCount: changedFiles.size, additions, deletions } });
    return version;
  });
}

export function recordFlowEvent(task: RepoTask, event: FlowEvent | ReviewRerunEvent) {
  const store = getStateStore();
  store.transaction(() => {
    const previousSteps = new Map((task.flowSteps ?? []).map((step) => [step.id, step]));
    if (event.type === "flow_started") {
      task.flowId = event.flowId;
      task.flowStatus = "running";
      store.appendTaskEvent(task.id, { type: "flow_started", actor: "system", createdAt: event.timestamp, status: "running" });
    } else if (event.type === "rerun_started") {
      task.flowId = event.flowId;
      task.flowStatus = "running";
      const step = task.flowSteps?.find((item) => item.id === event.stepId);
      store.appendTaskEvent(task.id, { type: "step_rerun", actor: step?.agent ?? "system", createdAt: event.timestamp, stepId: event.stepId, status: "started" });
    } else if ("step" in event) {
      const steps = task.flowSteps ?? [];
      const index = steps.findIndex((step) => step.id === event.step.id);
      if (index >= 0) steps[index] = event.step;
      else steps.push(event.step);
      task.flowSteps = steps;
      const started = event.type === "step_started" || event.type === "rerun_step_started";
      const completed = event.type === "step_completed" || event.type === "rerun_step_completed";
      const type = started ? "step_started" : completed ? "step_completed" : "step_failed";
      const createdAt = started ? event.step.startedAt : event.step.completedAt;
      store.appendTaskEvent(task.id, { type, actor: event.step.agent, createdAt, stepId: event.step.id, status: event.step.status, metadata: event.step.durationMs === undefined ? undefined : { durationMs: event.step.durationMs } });
      if (!started && event.type !== "step_skipped") store.appendStepVersion(task.id, event.step, createdAt);
    } else {
      task.flowId = event.result.flowId;
      task.flowStatus = event.result.status;
      task.flowSteps = event.result.steps;
      task.finalOutput = event.result.finalOutput;
      if (event.type.startsWith("rerun_")) {
        for (const step of event.result.steps) {
          if (step.status === "stale" && previousSteps.get(step.id)?.status !== "stale") {
            store.appendTaskEvent(task.id, { type: "step_stale", actor: "system", stepId: step.id, status: "stale" });
          }
        }
      }
      const aborted = event.type === "flow_aborted" || event.type === "flow_timed_out" || event.type === "rerun_aborted" || event.type === "rerun_timed_out";
      store.appendTaskEvent(task.id, { type: aborted ? "flow_aborted" : "flow_completed", actor: "system", status: event.result.status });
    }
    persistTask(task);
  });
}

export async function getTaskDiff(task: RepoTask): Promise<TaskDiff> {
  try {
    const { createDiffSnapshot, taskDiffFromSnapshot } = await import("./pull-request");
    return taskDiffFromSnapshot(await createDiffSnapshot(task));
  } catch (error) {
    return { trackedFiles: [], untrackedFiles: [], stat: "", patch: "", untrackedPatch: "", truncated: true, approvable: false, blockedReason: error instanceof Error ? error.message : "The approval snapshot cannot be displayed safely." };
  }
}

export async function deleteTask(id: string, input: { confirmedPrCleanup?: boolean } = {}) {
  if (!acquireTaskLock(id)) throw new Error("Task cleanup is blocked while another operation is running");
  try {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  const profile = requireTaskProfile(task);
  recordTaskEvent(task, "worktree_cleanup_requested", "user", { status: "requested", metadata: task.prNumber ? { prNumber: task.prNumber } : undefined });
  if (!profile.cleanup.allowCleanWorktreeRemoval) throw new Error("The task profile forbids worktree cleanup");
  if (!task.worktreeAvailable || task.worktreeStatus !== "available") throw new Error("Managed task worktree is unavailable");
  if (task.prNumber && profile.cleanup.requireConfirmationIfPrOpen && input.confirmedPrCleanup !== true) throw new Error("Explicit confirmation is required before removing a PR task worktree");
  if (await runGit(task.worktreePath, ["status", "--porcelain"]) && !profile.cleanup.allowDirtyWorktreeRemoval) throw new Error("Task worktree has uncommitted changes and cannot be deleted");
  const root = await realpath(task.worktreeRoot);
  const target = await realpath(task.worktreePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Invalid worktree path");
  await runGit(task.repoPath, ["worktree", "remove", task.worktreePath]);
  const store = getStateStore();
  store.transaction(() => {
    task.status = "archived";
    task.worktreeAvailable = false;
    task.worktreeStatus = "removed";
    task.recoveryStatus = "recoverable";
    task.recoveryMessage = "Task worktree was removed and the task was archived.";
    invalidateApproval(task);
    persistTask(task);
    store.appendTaskEvent(task.id, { type: "worktree_removed", actor: "system", status: "removed", metadata: task.prNumber ? { prNumber: task.prNumber } : undefined });
    store.appendTaskEvent(task.id, { type: "task_archived", actor: "user", status: "archived" });
  });
  } finally { releaseTaskLock(id); }
}

export async function initializeTaskRecovery(options: { allowedRoot?: string; worktreeRoot?: string } = {}) {
  loadPersistedTasks();
  if (!recoveryPromise) recoveryPromise = (async () => {
    const { reconcileUnfinishedOperations } = await import("./operation-reconciliation");
    await reconcileUnfinishedOperations();
    await recoverAllTasks(options.allowedRoot ?? ALLOWED_ROOT, options.worktreeRoot ?? WORKTREE_ROOT);
  })();
  await recoveryPromise;
}

export async function resumeTask(id: string, options: { allowedRoot?: string; worktreeRoot?: string } = {}) {
  loadPersistedTasks();
  const task = tasks.get(id);
  if (!task) return undefined;
  await recoverTask(task, options.allowedRoot ?? ALLOWED_ROOT, options.worktreeRoot ?? WORKTREE_ROOT);
  if (!task.profileSnapshotValid) throw new Error(task.recoveryMessage ?? "Task profile snapshot is invalid");
  if (!task.templateSnapshotValid) throw new Error(task.recoveryMessage ?? "Task template snapshot is invalid");
  if (task.status === "archived") throw new Error("Archived tasks cannot be resumed");
  if (task.recoveryStatus === "invalid") throw new Error(task.recoveryMessage ?? "Task failed recovery validation");
  recordTaskEvent(task, "task_resumed", "user", { status: task.recoveryStatus });
  return task;
}

async function recoverAllTasks(allowedRoot: string, worktreeRoot: string) {
  for (const task of tasks.values()) await recoverTask(task, allowedRoot, worktreeRoot);
}

async function recoverTask(task: RepoTask, allowedRoot: string, worktreeRoot: string) {
  let template: TaskTemplateSnapshot;
  try { requireTaskProfile(task); template = requireTaskTemplate(task); }
  catch (error) {
    task.profileSnapshotValid = false;
    task.templateSnapshotValid = false;
    task.recoveryStatus = "needs_attention";
    task.recoveryMessage = error instanceof Error ? error.message : "Task profile snapshot is invalid";
    getStateStore().markTaskProfileNeedsAttention(task.id, task.recoveryMessage);
    evaluateTaskNotifications(task);
    return;
  }
  if (template.readOnly) {
    try {
      const expectedRoot = await realpath(allowedRoot);
      const savedRoot = await realpath(task.allowedRoot);
      if (savedRoot !== expectedRoot) throw new Error("Saved allowed root does not match the server allowed root");
      const repo = await validateRepository(task.repoId, allowedRoot);
      if (await realpath(task.repoPath) !== repo.path || await realpath(task.worktreePath) !== repo.path) throw new Error("Saved read-only task repository path does not match the allowed repository");
      if (repo.branch !== task.baseBranch) throw new Error("Base repository branch changed after task creation");
      const base = await classifyTaskBase(task, repo.path);
      if (base.state === "base_missing") throw new Error("Original task base commit is missing");
      if (base.state === "base_diverged") throw new Error("Base branch diverged from the original task base");
      task.worktreeAvailable = false;
      task.worktreeStatus = "not_required";
      task.recoveryStatus = task.runtimeViolation ? "needs_attention" : "recoverable";
      task.recoveryMessage = task.runtimeViolation?.message ?? (base.state === "base_advanced"
        ? `Base advanced by ${base.aheadCount} commit${base.aheadCount === 1 ? "" : "s"}; read-only task remains recoverable.`
        : "Read-only template snapshot restored; no managed worktree, commit, push, or PR is permitted.");
      persistTask(task);
    } catch (error) {
      task.worktreeAvailable = false;
      task.worktreeStatus = "invalid";
      task.recoveryStatus = "invalid";
      task.recoveryMessage = error instanceof Error ? error.message : "Read-only task recovery validation failed";
      persistTask(task);
    }
    return;
  }
  if (task.status === "archived" && task.worktreeStatus === "removed") {
    task.worktreeAvailable = false;
    task.recoveryStatus = "recoverable";
    task.recoveryMessage = "Archived task; managed worktree was removed.";
    persistTask(task);
    return;
  }
  try {
    const expectedRoot = await realpath(allowedRoot);
    const savedRoot = await realpath(task.allowedRoot);
    if (savedRoot !== expectedRoot) throw new Error("Saved allowed root does not match the server allowed root");
    const expectedWorktreeRoot = await realpath(worktreeRoot);
    const savedWorktreeRoot = await realpath(task.worktreeRoot);
    if (savedWorktreeRoot !== expectedWorktreeRoot) throw new Error("Saved worktree root does not match the server-managed root");
    const repo = await validateRepository(task.repoId, allowedRoot);
    if (await realpath(task.repoPath) !== repo.path) throw new Error("Saved repository path does not match the allowed repository");
    if (repo.branch !== task.baseBranch) throw new Error("Base repository branch changed after task creation");
    const base = await classifyTaskBase(task, repo.path);
    if (base.state === "base_missing") throw new Error("Original task base commit is missing");
    if (base.state === "base_diverged") {
      task.worktreeAvailable = true;
      task.worktreeStatus = "available";
      task.recoveryStatus = "needs_attention";
      task.recoveryMessage = "Base branch diverged from the original task base. No automatic merge or rebase was attempted.";
    }
    const currentOrigin = await runGit(repo.path, ["remote", "get-url", "origin"]);
    if (!task.originUrl || currentOrigin !== task.originUrl) throw new Error("Repository origin changed after task creation");

    let worktreePath: string;
    try { worktreePath = await realpath(task.worktreePath); }
    catch {
      task.worktreeAvailable = false;
      task.worktreeStatus = "missing";
      task.recoveryStatus = "orphaned";
      task.recoveryMessage = task.prNumber
        ? "PR review can be inspected, but local rework is unavailable because the managed worktree is missing."
        : "Task worktree is missing. Manual recovery required.";
      invalidateApprovalForRestart(task);
      persistTask(task);
      return;
    }
    const expectedPath = await realpath(join(expectedWorktreeRoot, task.repoId, task.id));
    if (worktreePath !== expectedPath) throw new Error("Saved worktree path is not the server-managed task path");
    const registered = (await runGit(repo.path, ["worktree", "list", "--porcelain"]))
      .split("\n").some((line) => line === `worktree ${worktreePath}`);
    if (!registered) throw new Error("Task worktree is not registered with Git");
    if (await runGit(worktreePath, ["branch", "--show-current"]) !== task.branch) throw new Error("Task branch does not match the worktree");
    if (await realpath(await runGit(worktreePath, ["rev-parse", "--show-toplevel"])) !== worktreePath) throw new Error("Invalid task worktree root");
    if (await runGit(worktreePath, ["remote", "get-url", "origin"]) !== currentOrigin) throw new Error("Task worktree origin does not match the base repository");
    const dotGit = await lstat(join(worktreePath, ".git"));
    if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw new Error("Unexpected .git entry in task worktree");
    if (!TASK_BRANCH_PATTERN.test(task.branch) || task.branch !== `multiagents/${task.id}`) throw new Error("Invalid task branch");
    const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    const expectedHead = task.commitSha ?? task.baseSha;
    if (head !== expectedHead) throw new Error("Task branch HEAD does not match the persisted state");
    if (task.prNumber) {
      const coordinates = githubCoordinates(currentOrigin);
      const expectedUrl = `https://github.com/${coordinates.owner}/${coordinates.repo}/pull/${task.prNumber}`;
      if (task.prUrl !== expectedUrl) throw new Error("Persisted PR URL does not match the repository and PR number");
      if (task.prReview && (task.prReview.number !== task.prNumber || task.prReview.base !== task.baseBranch || task.prReview.head !== task.branch)) {
        throw new Error("Persisted PR metadata does not match the task");
      }
      const prHead = task.prReview?.headSha ?? task.latestPushedSha ?? task.commitSha;
      if (prHead && task.commitSha && prHead !== task.commitSha) throw new Error("Persisted PR head SHA does not match the task commit");
    }
    task.worktreeAvailable = true;
    task.worktreeStatus = "available";
    const approvalWasInvalidated = invalidateApprovalForRestart(task)
      || (task.approvalState === "invalidated" && ["approval_invalidated", "commit_failed"].includes(task.status));
    task.recoveryStatus = base.state === "base_diverged" || task.runtimeViolation || approvalWasInvalidated || Boolean(task.prNumber) || ["ci_pending", "checking_ci", "fetching_review"].includes(task.status)
      ? "needs_attention" : "recoverable";
    task.recoveryMessage = base.state === "base_diverged"
      ? "Base branch diverged from the original task base. No automatic merge or rebase was attempted."
      : task.runtimeViolation?.message ?? (approvalWasInvalidated
      ? "Approval was invalidated after restart. Review the current diff and run validation again."
      : task.prNumber ? "PR and CI state must be refreshed from GitHub."
        : base.state === "base_advanced" ? `Base advanced by ${base.aheadCount} commit${base.aheadCount === 1 ? "" : "s"}.` : undefined);
    persistTask(task);
  } catch (error) {
    task.worktreeAvailable = false;
    task.worktreeStatus = "invalid";
    task.recoveryStatus = "invalid";
    task.recoveryMessage = error instanceof Error ? error.message : "Task recovery validation failed";
    invalidateApprovalForRestart(task);
    persistTask(task);
  }
}

export async function classifyTaskBase(task: Pick<RepoTask, "baseSha" | "baseState" | "baseAheadCount">, repoPath: string) {
  try { await runGit(repoPath, ["cat-file", "-e", `${task.baseSha}^{commit}`]); }
  catch {
    task.baseState = "base_missing";
    task.baseAheadCount = undefined;
    return { state: task.baseState, aheadCount: 0 } as const;
  }
  const current = await runGit(repoPath, ["rev-parse", "HEAD"]);
  if (current === task.baseSha) {
    task.baseState = "base_current";
    task.baseAheadCount = 0;
    return { state: task.baseState, aheadCount: 0 } as const;
  }
  try {
    await runGit(repoPath, ["merge-base", "--is-ancestor", task.baseSha, current]);
    const aheadCount = Number(await runGit(repoPath, ["rev-list", "--count", `${task.baseSha}..${current}`]));
    task.baseState = "base_advanced";
    task.baseAheadCount = Number.isSafeInteger(aheadCount) && aheadCount >= 1 ? aheadCount : 1;
    return { state: task.baseState, aheadCount: task.baseAheadCount } as const;
  } catch {
    task.baseState = "base_diverged";
    task.baseAheadCount = undefined;
    return { state: task.baseState, aheadCount: 0 } as const;
  }
}

function githubCoordinates(origin: string) {
  const match = origin.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
    ?? origin.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error("Persisted origin is not a supported GitHub repository");
  return { owner: match[1], repo: match[2] };
}

function invalidateApprovalForRestart(task: RepoTask) {
  const active = task.approvalState === "pending" || task.approvalState === "processing";
  if (!active) return false;
  const approval = task.approvalId && task.diffHash && task.approvalPurpose
    ? { approvalId: task.approvalId, diffHash: task.diffHash, purpose: task.approvalPurpose }
    : undefined;
  task.approvalState = "invalidated";
  task.approvalId = undefined;
  if (["awaiting_approval", "validating"].includes(task.status)) task.status = "approval_invalidated";
  else if (task.status === "awaiting_final_approval") task.status = "approval_invalidated";
  else if (["committing", "committing_rework"].includes(task.status)) task.status = "commit_failed";
  if (approval) recordApprovalEvent(task, "invalidated", approval, "server_restart");
  return true;
}

function loadPersistedTasks() {
  if (tasksLoaded) return;
  tasksLoaded = true;
  for (const task of getStateStore().loadTasks()) {
    if (task.flowStatus === "running") {
      task.flowStatus = "aborted";
      task.flowSteps = task.flowSteps?.map((step) => step.status === "running"
        ? { ...step, status: "error", error: "Interrupted by server restart", completedAt: new Date().toISOString() }
        : step);
    }
    invalidateApprovalForRestart(task);
    task.recoveryStatus = "needs_attention";
    task.recoveryMessage = "Pending startup recovery validation.";
    tasks.set(task.id, task);
    if (task.profileSnapshotValid !== false && task.templateSnapshotValid !== false) persistTask(task);
  }
}

export function requireTaskProfile(task: RepoTask): ProjectProfileSnapshot {
  if (task.profileSnapshotValid === false) throw new Error("Task profile snapshot is inconsistent. Human attention is required.");
  const profile = parseProfileSnapshot(task.profile);
  if (profile.repoId !== task.repoId) throw new Error("Task profile snapshot repository does not match the task");
  task.profile = profile;
  task.profileSnapshotValid = true;
  return profile;
}

export function requireTaskTemplate(task: RepoTask): TaskTemplateSnapshot {
  if (task.templateSnapshotValid === false) throw new Error("Task template snapshot is inconsistent. Human attention is required.");
  const template = parseTemplateSnapshot(task.template);
  if (template.repoId !== task.repoId) throw new Error("Task template snapshot repository does not match the task");
  const expected = mergeTemplateWithProfile({ ...builtInTemplate(task.repoId, template.templateId), version: template.version, enabled: template.enabled }, requireTaskProfile(task));
  if (JSON.stringify(template) !== JSON.stringify(expected)) throw new Error("Task template snapshot is incompatible with its project profile snapshot");
  task.template = template;
  task.templateSnapshotValid = true;
  return template;
}

export function executionPromptForTask(task: RepoTask, prompt: string) {
  return taskExecutionPrompt(requireTaskTemplate(task), redactKnownSecrets(prompt));
}

export function executionRootForTask(task: RepoTask) {
  return requireTaskTemplate(task).readOnly ? task.repoPath : task.worktreePath;
}

export function clearTasksForTests() {
  tasks.clear();
  tasksLoaded = true;
  recoveryPromise = undefined;
  getStateStore().clearForTests();
}

export function reloadTasksFromStoreForTests() {
  tasks.clear();
  tasksLoaded = false;
  recoveryPromise = undefined;
  loadPersistedTasks();
}
