import type { DashboardResponse, DashboardTask, NextAction, PrFilter, TaskBucket } from "../dashboard/types";
import { taskBuckets } from "../dashboard/types";
import { runGit } from "./git";
import { getStateStore, type DashboardQuery, type DashboardRow } from "./state-store";
import { getTask, type RepoTask, type TaskStatus } from "./tasks";
import { evaluateInactiveTasks } from "./notifications";
import { redactKnownSecrets } from "./credential-resolver";

const MAX_DASHBOARD_LIMIT = 100;
const DEFAULT_DASHBOARD_LIMIT = 50;
const INACTIVE_AFTER_MS = 72 * 60 * 60 * 1_000;
const STATUS_VALUES = new Set<TaskStatus>([
  "draft", "reviewed", "awaiting_approval", "validating", "committing", "pushing", "creating_pr", "pr_created",
  "fetching_review", "review_ready", "awaiting_rework_approval", "reworking", "reviewing_rework", "awaiting_final_approval",
  "committing_rework", "pushing_rework", "checking_ci", "ready_for_human_merge", "review_fetch_failed", "rework_failed",
  "ci_failed", "ci_pending", "validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed", "push_failed",
  "pr_failed", "archived",
]);
const SORT_VALUES = new Set(["updated_desc", "created_desc", "repo_name"] as const);
const PR_FILTER_VALUES = new Set<PrFilter>(["any", "with_pr", "without_pr"]);
const NEXT_ACTION_LABELS: Record<NextAction, string> = {
  resume_flow: "Resume the task flow",
  review_diff: "Review the final diff",
  revalidate: "Resume and revalidate",
  relogin_github: "Sign in to GitHub, then retry",
  fetch_pr_review: "Refresh or fetch PR review status",
  apply_reviewed_fixes: "Apply reviewed fixes",
  review_rework_diff: "Review the revised diff",
  open_pr: "Open the pull request",
  human_merge: "Review and merge on GitHub",
  manual_recovery: "Perform manual recovery",
  cleanup: "Clean up the managed worktree",
};

export function parseDashboardQuery(url: URL): DashboardQuery {
  const bucketValue = url.searchParams.get("bucket") || undefined;
  if (bucketValue && !taskBuckets.includes(bucketValue as TaskBucket)) throw new DashboardQueryError("Invalid bucket");
  const repo = url.searchParams.get("repo")?.trim() || undefined;
  if (repo && !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new DashboardQueryError("Invalid repository filter");
  const status = url.searchParams.get("status")?.trim() || undefined;
  if (status && !STATUS_VALUES.has(status as TaskStatus)) throw new DashboardQueryError("Invalid status filter");
  const prValue = url.searchParams.get("pr") || "any";
  if (!PR_FILTER_VALUES.has(prValue as PrFilter)) throw new DashboardQueryError("Invalid PR filter");
  const sortValue = url.searchParams.get("sort") || "updated_desc";
  if (!SORT_VALUES.has(sortValue as "updated_desc")) throw new DashboardQueryError("Invalid sort order");
  const includeValue = url.searchParams.get("includeArchived");
  if (includeValue && includeValue !== "true" && includeValue !== "false") throw new DashboardQueryError("Invalid includeArchived value");
  const search = url.searchParams.get("search")?.trim() || undefined;
  if (search && search.length > 120) throw new DashboardQueryError("Search is limited to 120 characters");
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_DASHBOARD_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DASHBOARD_LIMIT) throw new DashboardQueryError("Limit must be an integer from 1 to 100");
  return {
    bucket: bucketValue as TaskBucket | undefined,
    repo,
    status,
    pr: prValue as PrFilter,
    search,
    sort: sortValue as DashboardQuery["sort"],
    includeArchived: includeValue === "true" || bucketValue === "archived",
    limit,
  };
}

export async function getDashboard(query: DashboardQuery, now = new Date()): Promise<DashboardResponse> {
  evaluateInactiveTasks(now);
  const result = getStateStore().queryDashboard(query);
  const tasks = await Promise.all(result.rows.map((row) => dashboardTask(row, now)));
  return { tasks, counts: result.counts, limit: query.limit };
}

export function summarizeTaskPrompt(prompt: string): string {
  const collapsed = redactKnownSecrets(prompt).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const redacted = collapsed
    .replace(/\b(password|passwd|secret|token|credential|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted]");
  if (!redacted) return "No task summary available";
  const characters = Array.from(redacted);
  return characters.length <= 120 ? redacted : `${characters.slice(0, 119).join("")}…`;
}

export function nextActionFor(row: Pick<DashboardRow, "bucket" | "status" | "worktreeStatus" | "prNumber">): NextAction {
  if (row.worktreeStatus === "missing" || row.worktreeStatus === "invalid") return "manual_recovery";
  if (row.bucket === "ready_for_human_merge") return "human_merge";
  if (row.bucket === "ready_for_approval") return row.status === "awaiting_final_approval" ? "review_rework_diff" : "review_diff";
  if (["approval_invalidated", "validation_failed", "secret_scan_failed", "commit_failed"].includes(row.status)) return "revalidate";
  if (["ci_failed", "ci_pending", "review_fetch_failed"].includes(row.status)) return "fetch_pr_review";
  if (row.status === "pr_failed") return "relogin_github";
  if (row.status === "awaiting_rework_approval" || row.status === "rework_failed") return "apply_reviewed_fixes";
  if (row.bucket === "pr_open") return row.prNumber ? "open_pr" : "fetch_pr_review";
  if (row.bucket === "archived") return "cleanup";
  return "resume_flow";
}

export function attentionReasonFor(row: Pick<DashboardRow, "status" | "recoveryStatus" | "recoveryMessage" | "worktreeStatus" | "payload">): string | undefined {
  if (row.worktreeStatus === "missing") return "The managed worktree is missing.";
  if (row.worktreeStatus === "invalid") return row.recoveryMessage || "The managed worktree failed recovery validation.";
  if (row.recoveryStatus === "orphaned" || row.recoveryStatus === "invalid") return row.recoveryMessage || "Task recovery requires manual attention.";
  const review = object(row.payload.prReview);
  if (review.merged === true) return "The pull request was merged outside MultiAgents.";
  if (review.state === "CLOSED") return "The pull request is closed.";
  const reasons: Partial<Record<TaskStatus, string>> = {
    approval_invalidated: "Approval was invalidated; the current diff must be reviewed again.",
    validation_failed: "Pre-PR validation failed.",
    secret_scan_failed: "The secret scan found blocked content.",
    commit_failed: "The commit step failed.",
    push_failed: "The branch push failed.",
    pr_failed: "Pull request creation failed or GitHub authentication needs attention.",
    review_fetch_failed: "PR status or review intake could not be refreshed.",
    rework_failed: "The reviewed-fixes flow failed.",
    ci_failed: "Required CI checks failed.",
    ci_pending: "Required CI checks are still pending.",
  };
  return reasons[row.status as TaskStatus] || row.recoveryMessage;
}

export function validatedDashboardPrUrl(task: RepoTask | undefined, row: Pick<DashboardRow, "prNumber" | "prUrl">): string | undefined {
  if (!task?.originUrl || !row.prNumber || !row.prUrl) return undefined;
  const match = task.originUrl.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
    ?? task.originUrl.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) return undefined;
  const expected = `https://github.com/${match[1]}/${match[2]}/pull/${row.prNumber}`;
  return row.prUrl === expected ? expected : undefined;
}

async function dashboardTask(row: DashboardRow, now: Date): Promise<DashboardTask> {
  const task = getTask(row.taskId);
  const sourceFinding = row.sourceFindingId ? getStateStore().loadFinding(row.sourceFindingId) : undefined;
  const profile = object(row.payload.profileSnapshot);
  const template = object(row.payload.templateSnapshot);
  let dirty = false;
  let cleanupCheckFailed = false;
  if (task?.worktreeAvailable && row.worktreeStatus === "available") {
    try { dirty = Boolean(await runGit(task.worktreePath, ["status", "--porcelain"])); }
    catch { cleanupCheckFailed = true; }
  }
  const prUrl = validatedDashboardPrUrl(task, row);
  const nextAction = nextActionFor(row);
  const hasPr = Boolean(row.prNumber);
  const cleanupBlocked = row.worktreeStatus !== "available" || !row.worktreeAvailable
    ? "The managed worktree is unavailable."
    : cleanupCheckFailed ? "Worktree cleanliness could not be verified."
      : dirty ? "Dirty worktrees cannot be deleted. Commit, stash, or discard changes manually first." : undefined;
  const warning = row.bucket === "ready_for_human_merge"
    ? "This task is ready for human merge. Removing its worktree is irreversible locally."
    : hasPr ? "This will not delete the GitHub branch or pull request." : undefined;
  const review = object(row.payload.prReview);
  return {
    id: row.taskId, repoId: row.repoId, repoName: row.repoName, summary: summarizeTaskPrompt(row.originalPrompt),
    status: row.status, bucket: row.bucket, branch: row.branch, baseBranch: row.baseBranch,
    prNumber: row.prNumber, prUrl, prState: typeof review.state === "string" ? review.state : undefined,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    inactive: now.getTime() - Date.parse(row.updatedAt) >= INACTIVE_AFTER_MS,
    recoveryStatus: row.recoveryStatus, recoveryMessage: row.recoveryMessage, worktreeStatus: row.worktreeStatus,
    profileName: typeof profile.name === "string" ? profile.name : "invalid profile",
    profileVersion: typeof profile.version === "number" ? profile.version : row.profileVersion ?? 0,
    templateName: typeof template.name === "string" ? template.name : "invalid template",
    templateVersion: typeof template.version === "number" ? template.version : row.templateVersion ?? 0,
    nextAction, nextActionLabel: NEXT_ACTION_LABELS[nextAction], attentionReason: row.bucket === "needs_attention" ? attentionReasonFor(row) : undefined,
    canResume: row.bucket !== "archived" && row.recoveryStatus !== "invalid", canViewDiff: row.worktreeAvailable && row.worktreeStatus === "available",
    canRefreshPr: Boolean(row.prNumber && prUrl),
    cleanup: { allowed: !cleanupBlocked, requiresConfirmation: hasPr, warning, blockedReason: cleanupBlocked },
    source: sourceFinding && row.sourceTaskId ? { findingId: sourceFinding.findingId, sourceTaskId: row.sourceTaskId, severity: sourceFinding.severity, title: sourceFinding.title } : undefined,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class DashboardQueryError extends Error {}
