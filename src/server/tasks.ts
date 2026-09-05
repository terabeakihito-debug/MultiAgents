import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { runGit } from "./git";
import { ALLOWED_ROOT, validateRepository } from "./repositories";
import type { PrReviewIntake, PullRequestReview, ReworkFlowResult } from "./pr-review-types";

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
  | "pr_failed";

export type ApprovalState = "unavailable" | "pending" | "processing" | "invalidated" | "used";
export type ApprovalPurpose = "create_pr" | "rework";
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
const MAX_UNTRACKED_FILES = 1_000;
const EXCLUDED_PARTS = new Set([".git", ".next", "node_modules"]);
const tasks = new Map<string, RepoTask>();

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
};

export async function createTask(repoId: string, options: { allowedRoot?: string; worktreeRoot?: string } = {}): Promise<RepoTask> {
  const allowedRoot = options.allowedRoot ?? ALLOWED_ROOT;
  const repo = await validateRepository(repoId, allowedRoot);
  if (repo.dirty) throw new Error("Repository has uncommitted changes. Commit or stash them before creating a worktree.");
  const id = randomUUID();
  const branch = `multiagents/${id}`;
  const worktreeRoot = options.worktreeRoot ?? WORKTREE_ROOT;
  const parent = join(worktreeRoot, repo.id);
  const worktreePath = join(parent, id);
  const baseSha = await runGit(repo.path, ["rev-parse", "HEAD"]);
  let originUrl: string | undefined;
  try { originUrl = await runGit(repo.path, ["remote", "get-url", "origin"]); } catch { /* approval reports a missing origin */ }
  await mkdir(parent, { recursive: true });
  await runGit(repo.path, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  const task: RepoTask = {
    id,
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    allowedRoot,
    branch,
    baseBranch: repo.branch,
    baseSha,
    originUrl,
    worktreePath,
    worktreeRoot,
    worktreeAvailable: true,
    status: "draft",
    prompt: "",
    reviewReady: false,
    approvalState: "unavailable",
    originalTaskAvailable: true,
    validation: [],
    secretFindings: [],
  };
  tasks.set(id, task);
  return task;
}

export function getTask(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return tasks.get(id);
}

export function listTasks() {
  return [...tasks.values()];
}

export function transitionTask(task: RepoTask, next: TaskStatus) {
  if (task.status === next) return;
  if (!transitions[task.status].includes(next)) throw new Error(`Invalid task transition: ${task.status} -> ${next}`);
  task.status = next;
}

export function beginTaskReview(task: RepoTask, prompt: string) {
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
}

export function completeTaskReview(task: RepoTask, finalReady: boolean) {
  if (task.status !== "draft") throw new Error("Review completion is not valid in the current task state");
  transitionTask(task, "reviewed");
  task.reviewReady = finalReady;
  if (finalReady) transitionTask(task, "awaiting_approval");
}

export function invalidateApproval(task: RepoTask) {
  task.diffHash = undefined;
  task.approvalId = undefined;
  task.approvalState = "unavailable";
  task.approvalPurpose = undefined;
}

export function registerRecoveredTask(task: RepoTask) {
  if (tasks.has(task.id)) throw new Error("Task is already registered");
  tasks.set(task.id, task);
  return task;
}

export function publicTask(task: RepoTask) {
  return {
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
  };
}

export async function getTaskDiff(task: RepoTask): Promise<TaskDiff> {
  const root = await realpath(task.worktreePath);
  const [statOutput, patch, trackedOutput, untrackedOutput] = await Promise.all([
    runGit(root, ["diff", "--stat", "HEAD", "--"]),
    runGit(root, ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"]),
    runGit(root, ["diff", "--name-only", "HEAD", "--"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const trackedFiles = trackedOutput ? trackedOutput.split("\n") : [];
  const allCandidates = untrackedOutput.split("\0").filter(Boolean).filter((name) => !name.split(/[\\/]/).some((part) => EXCLUDED_PARTS.has(part)));
  const candidates = allCandidates.slice(0, MAX_UNTRACKED_FILES);
  const sections: string[] = [];
  const untrackedFiles: string[] = [];
  let totalBytes = 0;
  let truncated = allCandidates.length > candidates.length;
  let blockedReason = truncated ? "The untracked file list exceeds the review display limit." : undefined;
  for (const name of candidates) {
    const path = join(root, name);
    const info = await lstat(path);
    const nameBytes = Buffer.byteLength(name, "utf8");
    if (totalBytes + nameBytes > MAX_UNTRACKED_TOTAL_BYTES) { truncated = true; blockedReason ??= "Untracked content exceeds the total review display limit."; break; }
    totalBytes += nameBytes;
    if (info.isSymbolicLink()) {
      untrackedFiles.push(name);
      sections.push(`Untracked symlink (content omitted): ${JSON.stringify(name)} -> ${JSON.stringify(await readlink(path))}`);
      continue;
    }
    if (!info.isFile()) continue;
    const target = await realpath(path);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    untrackedFiles.push(name);
    if (totalBytes >= MAX_UNTRACKED_TOTAL_BYTES) { truncated = true; blockedReason ??= "Untracked content exceeds the total review display limit."; break; }
    const allowance = Math.min(MAX_UNTRACKED_FILE_BYTES, MAX_UNTRACKED_TOTAL_BYTES - totalBytes);
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(allowance + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, Math.min(bytesRead, allowance));
      totalBytes += data.length;
      const limited = bytesRead > allowance || info.size > allowance;
      if (limited) { truncated = true; blockedReason ??= `Untracked file ${JSON.stringify(name)} exceeds the review display limit.`; }
      let body: string;
      try { body = new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch {
        blockedReason ??= `Untracked binary file ${JSON.stringify(name)} cannot be fully reviewed in this UI.`;
        sections.push(`Binary/untracked file (content omitted): ${JSON.stringify(name)}`);
        continue;
      }
      if (data.includes(0)) {
        blockedReason ??= `Untracked binary file ${JSON.stringify(name)} cannot be fully reviewed in this UI.`;
        sections.push(`Binary/untracked file (content omitted): ${JSON.stringify(name)}`);
        continue;
      }
      const lines = body.split("\n").map((line) => `+${line}`).join("\n");
      sections.push(`diff --git a/${name} b/${name}\nnew file mode ${info.mode & 0o111 ? "100755" : "100644"}\n--- /dev/null\n+++ b/${name}\n@@ untracked file @@\n${lines}${limited ? "\n[untracked file truncated]" : ""}`);
    } finally { await handle.close(); }
  }
  return {
    trackedFiles,
    untrackedFiles,
    stat: statOutput,
    patch,
    untrackedPatch: sections.join("\n\n"),
    truncated,
    approvable: !blockedReason,
    blockedReason,
  };
}

export async function deleteTask(id: string) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (task.commitSha) throw new Error("A pushed or committed task worktree requires explicit manual cleanup");
  if (await runGit(task.worktreePath, ["status", "--porcelain"])) throw new Error("Task worktree has uncommitted changes and cannot be deleted");
  const root = await realpath(task.worktreeRoot);
  const target = await realpath(task.worktreePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Invalid worktree path");
  await runGit(task.repoPath, ["worktree", "remove", task.worktreePath]);
  tasks.delete(id);
}

export function clearTasksForTests() { tasks.clear(); }
