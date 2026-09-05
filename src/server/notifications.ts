import type { Finding } from "../findings/types";
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
import { getStateStore } from "./state-store";
import { dispatchOutboundNotification } from "./outbound-notifications";
import type { RepoTask } from "./tasks";

const INACTIVE_AFTER_MS = 72 * 60 * 60 * 1_000;
const preferenceFor: Record<NotificationType, keyof NotificationPreferences> = {
  finding_critical_created: "criticalFindings",
  finding_high_created: "highFindings",
  task_needs_attention: "needsAttention",
  task_ready_for_approval: "readyForApproval",
  pr_changes_requested: "prChangesRequested",
  ci_failed: "ciFailed",
  pr_ready_for_human_merge: "readyForHumanMerge",
  task_inactive: "inactiveTask",
  worktree_orphaned: "worktreeOrphaned",
  approval_invalidated: "needsAttention",
};

type Candidate = Pick<AppNotification, "type" | "severity" | "title" | "message" | "dedupeKey">;

export function evaluateTaskNotifications(task: RepoTask, now = new Date()) {
  const head = safeKey(task.prReview?.headSha || task.latestPushedSha || task.commitSha || task.diffHash || "no-head");
  const needsAttention = taskIsInNeedsAttentionBucket(task);
  const changesRequested = Boolean(task.reviewIntake?.requiresRework)
    || Boolean(task.prReview?.items.some((item) => item.kind === "review" && item.state === "CHANGES_REQUESTED"));
  const ciFailed = task.status === "ci_failed" || Boolean(task.prReview?.checks.some((check) => check.required && check.bucket === "fail"));
  const rules: Array<[NotificationType, boolean, Candidate]> = [
    ["task_needs_attention", needsAttention, candidate("task_needs_attention", "warning", "Task needs attention", "A task moved to Needs Attention.", `task_needs_attention:${task.id}:${task.updatedAt}`)],
    ["task_ready_for_approval", ["awaiting_approval", "awaiting_final_approval"].includes(task.status), candidate("task_ready_for_approval", "info", "Task ready for approval", "A task is ready for human approval.", `task_ready_for_approval:${task.id}:${task.updatedAt}`)],
    ["pr_changes_requested", changesRequested, candidate("pr_changes_requested", "high", "PR changes requested", "A pull request requires reviewed changes.", `pr_changes_requested:${task.id}:${head}`)],
    ["ci_failed", ciFailed, candidate("ci_failed", "high", "Required CI checks failed", "Required checks failed for a pull request.", `ci_failed:${task.id}:${head}`)],
    ["pr_ready_for_human_merge", task.status === "ready_for_human_merge" || task.reviewIntake?.readyForHumanMerge === true, candidate("pr_ready_for_human_merge", "info", "PR ready for human merge", "A pull request is ready for human review and merge.", `pr_ready_for_human_merge:${task.id}:${head}`)],
    ["worktree_orphaned", task.recoveryStatus === "orphaned", candidate("worktree_orphaned", "warning", "Worktree orphaned", "A managed worktree requires manual recovery.", `worktree_orphaned:${task.id}:${task.updatedAt}`)],
    ["approval_invalidated", task.status === "approval_invalidated" || task.approvalState === "invalidated", candidate("approval_invalidated", "warning", "Approval invalidated", "A changed diff requires a new human approval.", `approval_invalidated:${task.id}:${task.updatedAt}`)],
    ["task_inactive", now.getTime() - Date.parse(task.updatedAt) >= INACTIVE_AFTER_MS && task.status !== "archived", candidate("task_inactive", "info", "Task inactive", "A task has not been updated for more than 72 hours.", `task_inactive:${task.id}:${task.updatedAt}`)],
  ];
  for (const [rule, active, value] of rules) evaluateTransition("task", task.id, rule, active, value, { repoId: task.repoId, repoName: task.repoName, taskId: task.id, prNumber: task.prNumber });
}

export function evaluateFindingNotification(finding: Finding) {
  const store = getStateStore();
  const source = store.loadTaskIdentity(finding.sourceTaskId);
  for (const severity of ["critical", "high"] as const) {
    const type = `finding_${severity}_created` as NotificationType;
    const active = finding.severity === severity && finding.status !== "dismissed" && !finding.resolvedAt;
    const value = severity === "critical"
      ? candidate(type, "critical", "Critical finding created", "Critical finding requires review.", `${type}:${finding.findingId}`)
      : candidate(type, "high", "High finding created", "High finding requires review.", `${type}:${finding.findingId}`);
    evaluateTransition("finding", finding.findingId, type, active, value, { repoId: source?.repoId, repoName: source?.repoName, taskId: finding.sourceTaskId, findingId: finding.findingId });
  }
}

export function evaluateInactiveTasks(now = new Date()) {
  for (const task of getStateStore().loadTasks()) evaluateTaskNotifications(task, now);
}

export function parseNotificationQuery(url: URL): NotificationQuery {
  const unread = url.searchParams.get("unreadOnly") ?? "false";
  if (!['true', 'false'].includes(unread)) throw new NotificationInputError("Invalid unread filter");
  const severity = url.searchParams.get("severity") || undefined;
  if (severity && !notificationSeverities.includes(severity as NotificationSeverity)) throw new NotificationInputError("Invalid severity filter");
  const type = url.searchParams.get("type") || undefined;
  if (type && !notificationTypes.includes(type as NotificationType)) throw new NotificationInputError("Invalid type filter");
  const repoId = url.searchParams.get("repo")?.trim() || undefined;
  if (repoId && !/^[A-Za-z0-9._-]{1,100}$/.test(repoId)) throw new NotificationInputError("Invalid repository filter");
  const limit = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new NotificationInputError("Invalid notification limit");
  return { unreadOnly: unread === "true", severity: severity as NotificationSeverity | undefined, type: type as NotificationType | undefined, repoId, limit };
}

export function parseNotificationPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotificationInputError("Preferences must be an object");
  const keys = Object.keys(defaultNotificationPreferences) as Array<keyof NotificationPreferences>;
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key as keyof NotificationPreferences))) throw new NotificationInputError("Preferences must contain exactly the supported fields");
  const parsed = value as Record<string, unknown>;
  if (keys.some((key) => typeof parsed[key] !== "boolean")) throw new NotificationInputError("Preference values must be boolean");
  return Object.fromEntries(keys.map((key) => [key, parsed[key]])) as NotificationPreferences;
}

export function browserNotificationPayload(notification: Pick<AppNotification, "type">) {
  const body: Record<NotificationType, string> = {
    finding_critical_created: "A critical operational item requires review.", finding_high_created: "A high-priority operational item requires review.",
    task_needs_attention: "A task needs attention.", task_ready_for_approval: "A task is ready for approval.",
    pr_changes_requested: "A pull request needs reviewed changes.", ci_failed: "Required checks failed.",
    pr_ready_for_human_merge: "A pull request is ready for human merge.", task_inactive: "A task has become inactive.",
    worktree_orphaned: "A managed worktree needs attention.", approval_invalidated: "A task approval was invalidated.",
  };
  if (!notificationTypes.includes(notification.type)) throw new NotificationInputError("Invalid notification type");
  return { title: "MultiAgents", body: body[notification.type] };
}

function evaluateTransition(subjectType: "task" | "finding", subjectId: string, rule: NotificationType, active: boolean, value: Candidate, relations: Pick<AppNotification, "repoId" | "repoName" | "taskId" | "findingId" | "prNumber">) {
  const store = getStateStore();
  const prior = store.loadWatchRuleState(subjectType, subjectId, rule);
  let notifiedKey = prior?.lastNotifiedKey;
  const keyMayRetriggerWhileActive = ["pr_changes_requested", "ci_failed", "pr_ready_for_human_merge"].includes(rule);
  const newlyActive = prior?.lastState !== "active";
  const shouldNotify = active && (!prior?.lastNotifiedKey || (keyMayRetriggerWhileActive && prior.lastNotifiedKey !== value.dedupeKey));
  if (shouldNotify && (newlyActive || keyMayRetriggerWhileActive || !prior?.lastNotifiedKey) && store.loadNotificationPreferences()[preferenceFor[rule]]) {
    const notification = store.createBuiltInNotification({ ...value, ...relations });
    if (notification) void dispatchOutboundNotification(notification.notificationId).catch(() => undefined);
    notifiedKey = value.dedupeKey;
  }
  store.saveWatchRuleState(subjectType, subjectId, rule, active ? "active" : "inactive", active ? notifiedKey : undefined);
}

function candidate(type: NotificationType, severity: NotificationSeverity, title: string, message: string, dedupeKey: string): Candidate {
  return { type, severity, title: title.slice(0, 120), message: message.slice(0, 240), dedupeKey: safeKey(dedupeKey) };
}

function safeKey(value: string) { return value.replace(/[^A-Za-z0-9:._-]/g, "-").slice(0, 500); }
function taskIsInNeedsAttentionBucket(task: RepoTask) {
  if (task.status === "archived" || task.worktreeStatus === "removed") return false;
  if (task.status === "ready_for_human_merge") return false;
  if (["needs_attention", "orphaned", "invalid"].includes(task.recoveryStatus)
    || ["missing", "invalid"].includes(task.worktreeStatus)
    || ["review_fetch_failed", "rework_failed", "ci_failed", "ci_pending", "validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed", "push_failed", "pr_failed"].includes(task.status)
    || ["aborted", "timed_out", "error"].includes(task.flowStatus ?? "")
    || task.prReview?.state === "CLOSED" || task.prReview?.state === "MERGED") return true;
  if (["awaiting_approval", "awaiting_final_approval"].includes(task.status)) return false;
  if (task.prNumber) return false;
  if (["draft", "reviewed", "validating", "committing", "pushing", "creating_pr", "fetching_review", "reworking", "reviewing_rework", "committing_rework", "pushing_rework", "checking_ci"].includes(task.status) || task.flowStatus === "running") return false;
  return true;
}
export class NotificationInputError extends Error {}
