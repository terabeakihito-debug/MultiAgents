import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { getStateStore } from "./state-store";
import { lsRemoteTransport, runGit } from "./git";
import { validatedTaskRemoteUrl } from "./pull-request";
import { getTask, listTasks, persistTask } from "./tasks";
import type { DurableOperation } from "../operations/types";
import { reconcileStaleSlackDeliveries } from "./outbound-notifications";
import { registerChildProcess } from "./child-process-registry";

type PullMatch = { number: number; url: string; headRefOid: string; headRefName: string; baseRefName: string };
type ReconcileDependencies = { findPullRequests?: (taskId: string) => Promise<PullMatch[]>; now?: Date };

export async function reconcileUnfinishedOperations(dependencies: ReconcileDependencies = {}) {
  const store = getStateStore();
  reconcileStaleSlackDeliveries(dependencies.now);
  const operations = store.loadUnfinishedOperations().filter((operation) => operation.type !== "slack_delivery");
  for (const operation of operations) {
    try {
      if (operation.type === "worktree_create") await reconcileWorktree(operation);
      else if (operation.type === "git_commit") await reconcileCommit(operation);
      else if (operation.type === "git_push") await reconcilePush(operation);
      else if (operation.type === "pr_create") await reconcilePullRequest(operation, dependencies.findPullRequests);
      else if (operation.type === "finding_conversion") reconcileFindingConversion(operation);
      else if (operation.type.startsWith("cleanup_")) store.updateOperation(operation.operationId, "reconcile_required", undefined, "cleanup_filesystem_recheck_required");
    } catch {
      store.updateOperation(operation.operationId, "reconcile_required", undefined, `${operation.type}_reconcile_failed`);
    }
  }
  return store.loadUnfinishedOperations();
}

async function reconcileWorktree(operation: DurableOperation) {
  const store = getStateStore();
  const task = operation.taskId ? getTask(operation.taskId) : undefined;
  if (!task) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "task_missing");
  try {
    const path = await realpath(task.worktreePath);
    const dotGit = await lstat(`${path}/.git`);
    const registered = (await runGit(task.repoPath, ["worktree", "list", "--porcelain"])).split("\n").includes(`worktree ${path}`);
    const branch = await runGit(path, ["branch", "--show-current"]);
    const head = await runGit(path, ["rev-parse", "HEAD"]);
    if (!registered || !dotGit.isFile() || dotGit.isSymbolicLink() || branch !== task.branch || head !== task.baseSha) throw new Error();
    store.transaction(() => {
      task.worktreeAvailable = true; task.worktreeStatus = "available"; task.recoveryStatus = "recoverable"; task.recoveryMessage = "Managed worktree creation was recovered from the operation journal.";
      persistTask(task); store.updateOperation(operation.operationId, "persisted");
    });
  } catch {
    task.worktreeAvailable = false; task.worktreeStatus = "missing"; task.recoveryStatus = "needs_attention";
    task.recoveryMessage = "Managed worktree creation did not complete; no automatic deletion or recreation was attempted.";
    persistTask(task);
    store.updateOperation(operation.operationId, operation.state === "prepared" ? "failed" : "reconcile_required", undefined, "worktree_not_adoptable");
  }
}

async function reconcileCommit(operation: DurableOperation) {
  const store = getStateStore();
  const task = operation.taskId ? getTask(operation.taskId) : undefined;
  if (!task) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "task_missing");
  const expectedParent = stringMeta(operation, "expectedParent");
  const expectedTree = stringMeta(operation, "expectedTree");
  const head = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
  if (head === expectedParent) {
    task.status = "commit_failed"; task.recoveryStatus = "needs_attention"; task.recoveryMessage = "The journal confirms that the commit did not complete.";
    persistTask(task); store.updateOperation(operation.operationId, "failed", undefined, "commit_not_created"); return;
  }
  const [parent, tree] = await Promise.all([
    runGit(task.worktreePath, ["rev-parse", `${head}^`]), runGit(task.worktreePath, ["rev-parse", `${head}^{tree}`]),
  ]);
  if (parent !== expectedParent || tree !== expectedTree) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "commit_identity_mismatch");
  store.transaction(() => {
    task.commitSha = head; task.approvalState = "used"; task.status = "push_failed"; task.recoveryStatus = "needs_attention";
    task.recoveryMessage = "Verified commit adopted after restart. Push was not automatically retried.";
    persistTask(task); store.updateOperation(operation.operationId, "persisted", { commitSha: head });
  });
}

async function reconcilePush(operation: DurableOperation) {
  const store = getStateStore();
  const task = operation.taskId ? getTask(operation.taskId) : undefined;
  if (!task) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "task_missing");
  const expected = stringMeta(operation, "expectedSha");
  const output = await lsRemoteTransport(validatedTaskRemoteUrl(task), task.branch);
  const matches = output.split("\n").filter(Boolean).map((line) => line.split(/\s+/)[0]);
  if (!matches.length) {
    task.status = "push_failed"; task.recoveryStatus = "needs_attention"; task.recoveryMessage = "Remote branch was not found; push may be retried by a human.";
    persistTask(task); store.updateOperation(operation.operationId, "failed", undefined, "remote_branch_missing"); return;
  }
  if (matches.length !== 1 || matches[0] !== expected) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "remote_sha_mismatch");
  store.transaction(() => {
    task.latestPushedSha = expected; task.status = task.prNumber ? "review_fetch_failed" : "pr_failed"; task.recoveryStatus = "needs_attention";
    task.recoveryMessage = task.prNumber ? "Verified rework push adopted after restart. Refresh PR and CI state." : "Verified remote push adopted after restart. PR creation was not automatically started.";
    persistTask(task); store.updateOperation(operation.operationId, "persisted");
  });
}

async function reconcilePullRequest(operation: DurableOperation, finder?: ReconcileDependencies["findPullRequests"]) {
  const store = getStateStore();
  const task = operation.taskId ? getTask(operation.taskId) : undefined;
  if (!task) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "task_missing");
  const pulls = await (finder ? finder(task.id) : findPullRequests(task));
  const expectedSha = stringMeta(operation, "expectedSha");
  const exact = pulls.filter((pull) => pull.headRefName === task.branch && pull.baseRefName === task.baseBranch && pull.headRefOid === expectedSha);
  if (!exact.length) {
    task.status = "pr_failed"; task.recoveryStatus = "needs_attention"; task.recoveryMessage = "No matching open PR was found; human retry is available.";
    persistTask(task); store.updateOperation(operation.operationId, "failed", undefined, "matching_pr_missing"); return;
  }
  if (exact.length !== 1) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "multiple_matching_prs");
  const match = exact[0];
  store.transaction(() => {
    task.prNumber = match.number; task.prUrl = match.url; task.status = "pr_created"; task.recoveryStatus = "needs_attention";
    task.recoveryMessage = "Existing pull request adopted after restart; refresh review and CI state.";
    persistTask(task); store.updateOperation(operation.operationId, "persisted", { prNumber: match.number });
  });
}

function reconcileFindingConversion(operation: DurableOperation) {
  const store = getStateStore();
  if (!operation.findingId) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "finding_missing");
  const finding = store.loadFinding(operation.findingId);
  if (!finding) return void store.updateOperation(operation.operationId, "reconcile_required", undefined, "finding_missing");
  const candidates = listTasks().filter((task) => task.sourceFindingId === finding.findingId && task.sourceTaskId === finding.sourceTaskId);
  if (candidates.length !== 1) return void store.updateOperation(operation.operationId, candidates.length ? "reconcile_required" : "failed", undefined, candidates.length ? "multiple_linked_tasks" : "linked_task_missing");
  const task = candidates[0];
  store.transaction(() => {
    if (finding.status !== "converted" || finding.convertedTaskId !== task.id) store.updateFindingStatus(finding.findingId, ["open", "accepted"], "converted", task.id);
    store.updateOperation(operation.operationId, "persisted", { implementationTaskId: task.id });
  });
}

async function findPullRequests(task: NonNullable<ReturnType<typeof getTask>>): Promise<PullMatch[]> {
  if (!task.originUrl) throw new Error("GitHub origin is unavailable");
  const match = task.originUrl.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
    ?? task.originUrl.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error("GitHub origin is unsupported");
  const output = await spawnBounded("/usr/bin/gh", ["pr", "list", "--repo", `${match[1]}/${match[2]}`, "--state", "open", "--head", task.branch, "--base", task.baseBranch, "--json", "number,url,headRefOid,headRefName,baseRefName"], task.worktreePath);
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("GitHub PR response is invalid");
  return parsed.filter(isPullMatch);
}

function spawnBounded(binary: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const registration = registerChildProcess({ child, purpose: "github" });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 200_000) stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 2_000) stderr += chunk; });
    child.once("error", (error) => { registration.unregister(); reject(error); });
    child.once("close", (code) => {
      registration.unregister();
      if (code === 0) resolve(stdout);
      else reject(new Error(`GitHub read-only reconciliation failed (${code}): ${stderr.slice(0, 400)}`));
    });
  });
}
function stringMeta(operation: DurableOperation, key: string) {
  const value = operation.safeMetadata[key];
  if (typeof value !== "string" || !value) throw new Error(`Operation metadata ${key} is missing`);
  return value;
}
function isPullMatch(value: unknown): value is PullMatch {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.number) && typeof row.url === "string" && typeof row.headRefOid === "string" && typeof row.headRefName === "string" && typeof row.baseRefName === "string";
}
