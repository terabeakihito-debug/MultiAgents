import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { agents } from "../agents";
import { hasRequiredAction, pullRequestCanBeMergedByHuman, runPrReviewIntake, runPrReworkFlow } from "../flows/pr-review";
import { runGit } from "./git";
import {
  COMMAND_TIMEOUT_MS,
  GH_BINARY,
  ApprovalError,
  createDiffSnapshot,
  runFixedProcess,
  runProjectValidation,
  scanSecrets,
  validateGitHubRemote,
  type ApprovalDependencies,
  type ApprovalInput,
} from "./pull-request";
import type { PullRequestCheck, PullRequestReview, PullRequestReviewItem, ReviewDisposition } from "./pr-review-types";
import { ALLOWED_ROOT, validateRepository } from "./repositories";
import { acquireTaskLock, isTaskLocked, releaseTaskLock } from "./task-lock";
import { WORKTREE_ROOT, getTask, getTaskDiff, persistTask, publicTask, recordApprovalEvent, recordDiffVersion, recordTaskEvent, registerRecoveredTask, requireTaskProfile, transitionTask, type RepoTask } from "./tasks";

const MAX_REVIEW_BODY_CHARS = 10_000;
const MAX_REVIEW_ITEMS = 200;
export const CI_POLL_TIMEOUT_MS = 5 * 60_000;
export const CI_POLL_INTERVAL_MS = 10_000;
export type OpenPullRequest = { number: number; title: string; url: string; draft: boolean; base: string; head: string; headSha: string };

type GhResult = { stdout: string; stderr: string; code: number | null; stdoutTruncated: boolean };
export type PrReviewDependencies = {
  fetchReview: (task: RepoTask) => Promise<PullRequestReview>;
  fetchDiff: (task: RepoTask) => Promise<string>;
  runIntake: typeof runPrReviewIntake;
  runRework: typeof runPrReworkFlow;
  stage: (task: RepoTask) => Promise<void>;
  commit: (task: RepoTask) => Promise<void>;
  push: (task: RepoTask) => Promise<void>;
  checkGhAuth: (task: RepoTask) => Promise<void>;
  checkDependencies: ApprovalDependencies["checkDependencies"];
  runValidation: ApprovalDependencies["runValidation"];
  verifyPush: (task: RepoTask, expectedSha: string) => Promise<PullRequestReview>;
  pollCi: (task: RepoTask) => Promise<{ status: "pass" | "fail" | "pending"; review: PullRequestReview; message: string }>;
};

const defaults: PrReviewDependencies = {
  fetchReview: fetchPullRequestReview,
  fetchDiff: fetchPullRequestDiff,
  runIntake: runPrReviewIntake,
  runRework: runPrReworkFlow,
  stage: async (task) => { await runGit(task.worktreePath, ["add", "--all"]); },
  commit: async (task) => { await runGit(task.worktreePath, ["commit", "-m", "multiagents: address PR review"]); },
  push: async (task) => { await runGit(task.worktreePath, ["push", "origin", task.branch]); },
  checkGhAuth: async (task) => { await checkedGh(["auth", "status", "--hostname", "github.com"], task.worktreePath); },
  checkDependencies: async (task) => { const { checkTaskDependencies } = await import("./pull-request"); await checkTaskDependencies(task); },
  runValidation: async (task, script, timeoutMs) => { const { runValidationCommand } = await import("./pull-request"); await runValidationCommand(task, script, timeoutMs); },
  verifyPush: async (task, expectedSha) => {
    const review = await fetchPullRequestReview(task);
    if (review.headSha !== expectedSha) throw new Error("Existing PR head did not update to the rework commit");
    return review;
  },
  pollCi: pollPullRequestCi,
};

export async function fetchReviewIntake(taskId: string, dependencies: Partial<PrReviewDependencies> = {}) {
  if (!acquireTaskLock(taskId)) throw new ApprovalError("This task is already being processed");
  const deps = { ...defaults, ...dependencies };
  try {
    const task = requireTask(taskId);
    if (!task.prNumber || !task.prUrl || !task.commitSha) throw new ApprovalError("Task does not have an existing pull request");
    if (!["pr_created", "review_ready", "awaiting_rework_approval", "ready_for_human_merge", "review_fetch_failed", "ci_failed", "ci_pending", "push_failed"].includes(task.status)) {
      throw new ApprovalError("Review fetch is not valid in the current task state");
    }
    transitionTask(task, "fetching_review");
    task.error = undefined;
    task.ciMessage = undefined;
    try {
      const review = await deps.fetchReview(task);
      await validateExistingPullRequest(task, review);
      const diff = await deps.fetchDiff(task);
      const intake = await deps.runIntake(task.prompt, diff, review, {
        agents,
        roles: requireTaskProfile(task).roles,
        cwd: task.worktreeAvailable ? task.worktreePath : task.repoPath,
        fingerprint: async () => reviewFingerprint(task),
      });
      if (intake.status !== "completed") throw new Error("PR review intake did not complete");
      task.prReview = review;
      task.reviewIntake = intake;
      task.reworkResult = undefined;
      task.reviewReady = false;
      recordTaskEvent(task, "pr_review_fetched", "system", { status: "completed", metadata: { prNumber: review.number, changedFileCount: review.changedFiles.length } });
      if (intake.readyForHumanMerge) {
        transitionTask(task, "ready_for_human_merge");
        recordTaskEvent(task, "ready_for_human_merge", "system", { status: "ready", metadata: { prNumber: review.number } });
      }
      else if (intake.requiresRework) transitionTask(task, "awaiting_rework_approval");
      else transitionTask(task, "review_ready");
      return publicTask(task);
    } catch (error) {
      transitionTask(task, "review_fetch_failed");
      task.error = safeError(error, "PR review fetch or intake failed");
      throw new ApprovalError(task.error);
    }
  } finally {
    const task = getTask(taskId); if (task) persistTask(task);
    releaseTaskLock(taskId);
  }
}

export async function applyReviewedFixes(taskId: string, input: { approved: true }, dependencies: Partial<PrReviewDependencies> = {}) {
  if (!acquireTaskLock(taskId)) throw new ApprovalError("This task is already being processed");
  const deps = { ...defaults, ...dependencies };
  try {
    const task = requireTask(taskId);
    const profile = requireTaskProfile(task);
    if (!profile.approval.beforeRework) throw new ApprovalError("Task profile does not require the mandatory rework approval gate");
    if (input.approved !== true) throw new ApprovalError("Explicit human approval is required", 400);
    if (task.status !== "awaiting_rework_approval" || !task.prReview || !task.reviewIntake?.requiresRework) throw new ApprovalError("Reviewed fixes are not awaiting approval");
    if (!task.originalTaskAvailable || !task.worktreeAvailable || !task.prompt) throw new ApprovalError("Original task context or managed worktree was lost after restart; rework cannot start safely");
    await validateExistingPullRequest(task, task.prReview);
    transitionTask(task, "reworking");
    recordTaskEvent(task, "rework_started", "user", { status: "running", metadata: task.prNumber ? { prNumber: task.prNumber } : undefined });
    task.error = undefined;
    task.reworkBaseSha = task.commitSha;
    let result;
    try {
      const diff = await deps.fetchDiff(task);
      result = await deps.runRework(task.prompt, diff, task.prReview, task.reviewIntake, {
        agents,
        roles: profile.roles,
        cwd: task.worktreePath,
        fingerprint: async () => (await createDiffSnapshot(task)).hash,
        getDiff: async () => {
          const current = await getTaskDiffForReview(task);
          return current;
        },
      });
    } catch {
      transitionTask(task, "rework_failed");
      task.error = "Rework flow failed. Nothing was committed or pushed.";
      throw new ApprovalError(task.error);
    }
    task.reworkResult = result;
    if (result.status !== "completed") {
      transitionTask(task, "rework_failed");
      task.error = "Rework flow failed. Nothing was committed or pushed.";
      throw new ApprovalError(task.error);
    }
    transitionTask(task, "reviewing_rework");
    const snapshot = await createDiffSnapshot(task);
    if (snapshot.empty) {
      transitionTask(task, "rework_failed");
      task.error = "Rework produced no revised diff. Nothing was committed or pushed.";
      throw new ApprovalError(task.error);
    }
    task.reviewReady = true;
    task.diffHash = snapshot.hash;
    task.approvalId = randomUUID();
    task.approvalState = "pending";
    task.approvalPurpose = "rework";
    task.validation = [];
    task.secretFindings = [];
    recordDiffVersion(task, snapshot.hash, await getTaskDiff(task));
    recordTaskEvent(task, "rework_completed", "system", { status: "completed", metadata: { diffHash: snapshot.hash } });
    recordApprovalEvent(task, "issued", { approvalId: task.approvalId, diffHash: task.diffHash, purpose: "rework" }, "pending");
    transitionTask(task, "awaiting_final_approval");
    return publicTask(task);
  } finally {
    const task = getTask(taskId); if (task) persistTask(task);
    releaseTaskLock(taskId);
  }
}

export async function approveRework(taskId: string, input: ApprovalInput, dependencies: Partial<PrReviewDependencies> = {}) {
  if (!acquireTaskLock(taskId)) throw new ApprovalError("This task is already being processed");
  const deps = { ...defaults, ...dependencies };
  try {
    const task = requireTask(taskId);
    const profile = requireTaskProfile(task);
    if (!profile.git.commitRequiresApproval || !profile.git.prRequired || !profile.approval.beforeCommit || !profile.approval.diffHashRequired || !profile.approval.secretScanRequired || !profile.approval.validationRequired || profile.git.mergeAllowedInApp || profile.git.forcePushAllowed || profile.git.deployAllowedInApp) {
      throw new ApprovalError("Task profile does not satisfy the enforced safe rework policy");
    }
    requireReworkApproval(task, input);
    const acceptedApproval = { approvalId: input.approvalId, diffHash: input.diffHash, purpose: "rework" as const };
    recordApprovalEvent(task, "accepted", acceptedApproval, "accepted");
    task.approvalState = "processing";
    transitionTask(task, "validating");
    recordTaskEvent(task, "validation_started", "system", { status: "running", metadata: { diffHash: input.diffHash } });
    task.validation = [];
    task.secretFindings = [];
    task.error = undefined;
    try {
      if (!task.prReview) throw new Error("PR review state is unavailable");
      await validateReworkSafety(task, task.prReview);
      const snapshot = await createDiffSnapshot(task);
      if (snapshot.empty || snapshot.hash !== input.diffHash) throw approvalInvalidated(task);
      task.validation.push({ name: "Diff hash", status: "pass", detail: "MATCH" });
      const findings = await scanSecrets(snapshot);
      task.secretFindings = findings;
      if (findings.length) {
        task.validation.push({ name: "Secret scan", status: "fail", detail: `${findings.length} finding(s)` });
        task.approvalState = "invalidated";
        transitionTask(task, "secret_scan_failed");
        task.error = "Secret scan found files or content that cannot be committed.";
        throw new ApprovalError(task.error);
      }
      task.validation.push({ name: "Secret scan", status: "pass" });
      await runProjectValidation(task, deps);
      await validateOrigin(task);
      task.validation.push({ name: "GitHub origin", status: "pass", detail: repositoryName(task) });
      await deps.checkGhAuth(task);
      task.validation.push({ name: "gh auth", status: "pass" });
      if ((await createDiffSnapshot(task)).hash !== input.diffHash) throw approvalInvalidated(task);
      recordTaskEvent(task, "validation_passed", "system", { status: "passed", metadata: { diffHash: input.diffHash } });

      transitionTask(task, "committing_rework");
      try {
        await deps.stage(task);
        if ((await createDiffSnapshot(task)).hash !== input.diffHash) throw approvalInvalidated(task);
        await deps.commit(task);
      } catch (error) {
        if (error instanceof ApprovalError) throw error;
        task.approvalState = "invalidated";
        transitionTask(task, "commit_failed");
        task.error = "Rework commit failed. Nothing was pushed.";
        throw new ApprovalError(task.error);
      }
      const commitSha = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
      if (commitSha === task.reworkBaseSha) throw new Error("Rework commit was not appended");
      task.commitSha = commitSha;
      task.approvalState = "used";
      persistTask(task);
      recordTaskEvent(task, "commit_created", "system", { status: "created", metadata: { commitSha } });

      transitionTask(task, "pushing_rework");
      try { await deps.push(task); }
      catch {
        transitionTask(task, "push_failed");
        task.error = "Rework push failed. No force-push or automatic retry was attempted.";
        throw new ApprovalError(task.error);
      }
      task.latestPushedSha = commitSha;
      recordTaskEvent(task, "branch_pushed", "system", { status: "pushed", metadata: { commitSha } });
      transitionTask(task, "checking_ci");
      const verified = await deps.verifyPush(task, commitSha);
      await validateExistingPullRequest(task, verified);
      task.prReview = markPotentiallyAddressed(verified);
      const ci = await deps.pollCi(task);
      task.prReview = markPotentiallyAddressed(ci.review);
      task.ciMessage = ci.message;
      if (ci.status === "fail") transitionTask(task, "ci_failed");
      else if (ci.status === "pending") transitionTask(task, "ci_pending");
      else if (hasRequiredAction(ci.review) || !pullRequestCanBeMergedByHuman(ci.review)) transitionTask(task, "review_ready");
      else {
        transitionTask(task, "ready_for_human_merge");
        recordTaskEvent(task, "ready_for_human_merge", "system", { status: "ready", metadata: task.prNumber ? { prNumber: task.prNumber, commitSha } : { commitSha } });
      }
      return publicTask(task);
    } catch (error) {
      const failure = error instanceof ApprovalError ? error : new ApprovalError(task.error ?? safeError(error, "Rework approval failed"));
      if (!(error instanceof ApprovalError) && task.status === "validating") {
        task.approvalState = "invalidated";
        transitionTask(task, "validation_failed");
        task.error = safeError(error, "Rework validation failed. No commit was created.");
      }
      if (task.approvalState === "invalidated") {
        if (["validation_failed", "secret_scan_failed", "approval_invalidated"].includes(task.status)) recordTaskEvent(task, "validation_failed", "system", { status: task.status, metadata: { diffHash: input.diffHash } });
        recordApprovalEvent(task, "invalidated", acceptedApproval, task.status);
        recordApprovalEvent(task, "failed", acceptedApproval, task.status);
      }
      throw error instanceof ApprovalError ? failure : new ApprovalError(task.error ?? failure.message);
    }
  } finally {
    const task = getTask(taskId); if (task) persistTask(task);
    releaseTaskLock(taskId);
  }
}

export async function fetchPullRequestReview(task: RepoTask): Promise<PullRequestReview> {
  if (!task.prNumber) throw new Error("Pull request number is unavailable");
  const repo = repositoryName(task);
  const cwd = task.worktreeAvailable ? task.worktreePath : task.repoPath;
  const [viewResult, commentsResult, threadsResult, requiredResult] = await Promise.all([
    checkedGh(["pr", "view", String(task.prNumber), "--repo", repo, "--json", "number,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,files,url,mergedAt,reviews,statusCheckRollup"], cwd),
    checkedGh(["api", `repos/${repo}/pulls/${task.prNumber}/comments`, "--paginate"], cwd),
    checkedGh(["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-F", `owner=${repo.split("/")[0]}`, "-F", `repo=${repo.split("/")[1]}`, "-F", `number=${task.prNumber}`], cwd),
    gh(["pr", "checks", String(task.prNumber), "--repo", repo, "--required"], cwd),
  ]);
  return parsePullRequestReview(viewResult.stdout, commentsResult.stdout, threadsResult.stdout, requiredResult);
}

export async function refreshPullRequestStatus(taskId: string, dependencies: { fetchReview?: (task: RepoTask) => Promise<PullRequestReview> } = {}) {
  if (!acquireTaskLock(taskId)) throw new ApprovalError("This task is already being processed", 409);
  try {
    const task = requireTask(taskId);
    if (!task.prNumber || !task.prUrl) throw new ApprovalError("Task does not have an existing pull request");
    const review = await (dependencies.fetchReview ?? fetchPullRequestReview)(task);
    await validatePullRequestIdentity(task, review, { allowClosed: true, allowDirty: true });
    task.prReview = review;
    const validationPassed = task.validation.some((check) => check.status === "pass") && !task.validation.some((check) => check.status === "fail");
    const requiredChecksPassed = !review.checks.some((check) => check.required && check.bucket !== "pass");
    const ready = review.state === "OPEN" && !review.merged && validationPassed && requiredChecksPassed
      && !hasRequiredAction(review) && pullRequestCanBeMergedByHuman(review);
    if (review.state !== "OPEN" || review.merged) {
      task.recoveryStatus = "needs_attention";
      task.recoveryMessage = review.merged ? "The pull request was merged outside MultiAgents." : "The pull request is closed.";
    } else if (task.worktreeStatus === "available") {
      task.recoveryStatus = "recoverable";
      task.recoveryMessage = undefined;
    }
    if (ready) task.status = "ready_for_human_merge";
    else if (task.status === "ready_for_human_merge") {
      if (review.checks.some((check) => check.required && check.bucket === "fail")) task.status = "ci_failed";
      else if (review.checks.some((check) => check.required && ["pending", "unknown"].includes(check.bucket))) task.status = "ci_pending";
      else task.status = "review_ready";
    }
    persistTask(task);
    recordTaskEvent(task, "pr_status_refreshed", "user", { status: review.state.toLowerCase(), metadata: { prNumber: review.number } });
    return publicTask(task);
  } finally {
    const task = getTask(taskId); if (task) persistTask(task);
    releaseTaskLock(taskId);
  }
}

export async function listOpenPullRequests(repoId: string, allowedRoot = ALLOWED_ROOT): Promise<OpenPullRequest[]> {
  const repo = await validateRepository(repoId, allowedRoot);
  const origin = await runGit(repo.path, ["remote", "get-url", "origin"]);
  const remote = validateGitHubRemote(origin);
  const result = await checkedGh(["pr", "list", "--repo", `${remote.owner}/${remote.repo}`, "--state", "open", "--limit", "100", "--json", "number,title,url,isDraft,baseRefName,headRefName,headRefOid"], repo.path);
  return array(JSON.parse(result.stdout)).map((value) => {
    const item = object(value);
    const number = positiveInteger(item.number, "PR number");
    const expectedUrl = `https://github.com/${remote.owner}/${remote.repo}/pull/${number}`;
    if (text(item.url) !== expectedUrl) throw new Error("Open PR repository does not match the selected repository");
    return { number, title: text(item.title), url: expectedUrl, draft: item.isDraft === true, base: text(item.baseRefName), head: text(item.headRefName), headSha: sha(item.headRefOid) };
  });
}

export async function recoverExistingPullRequestTask(repoId: string, prNumber: number, options: { allowedRoot?: string; worktreeRoot?: string; listPullRequests?: typeof listOpenPullRequests } = {}) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new ApprovalError("Pull request number is invalid", 400);
  const allowedRoot = options.allowedRoot ?? ALLOWED_ROOT;
  const worktreeRoot = options.worktreeRoot ?? WORKTREE_ROOT;
  const repo = await validateRepository(repoId, allowedRoot);
  const pulls = await (options.listPullRequests ?? listOpenPullRequests)(repoId, allowedRoot);
  const pull = pulls.find((item) => item.number === prNumber);
  if (!pull) throw new ApprovalError("Open pull request was not found in the selected GitHub repository", 404);
  if (pull.base !== repo.branch) throw new ApprovalError("Pull request base does not match the selected repository branch");
  const match = pull.head.match(/^multiagents\/([0-9a-f-]{36})$/);
  if (!match) throw new ApprovalError("Pull request head is not a server-generated task branch");
  const id = match[1];
  const expectedWorktree = join(worktreeRoot, repo.id, id);
  let worktree: string;
  try { worktree = await realpath(expectedWorktree); }
  catch {
    const origin = await runGit(repo.path, ["remote", "get-url", "origin"]);
    validateGitHubRemote(origin);
    const task: RepoTask = {
      id, repoId: repo.id, repoName: repo.name, repoPath: repo.path, allowedRoot, branch: pull.head, baseBranch: pull.base,
      baseSha: await runGit(repo.path, ["rev-parse", "HEAD"]), originUrl: origin, worktreePath: expectedWorktree, worktreeRoot,
      worktreeAvailable: false, status: "pr_created", prompt: "", reviewReady: false, approvalState: "unavailable",
      validation: [], secretFindings: [], commitSha: pull.headSha, prUrl: pull.url, prNumber: pull.number, originalTaskAvailable: false,
      error: "Task worktree is unavailable. Review intake is read-only; rework is disabled.",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoveryStatus: "orphaned", worktreeStatus: "missing",
    };
    registerRecoveredTask(task);
    return publicTask(task);
  }
  if (worktree !== expectedWorktree) throw new ApprovalError("Recovered worktree path is not canonical");
  const listing = await runGit(repo.path, ["worktree", "list", "--porcelain"]);
  if (!listing.split(/\n\n+/).some((entry) => entry.includes(`worktree ${worktree}\n`) && entry.includes(`branch refs/heads/${pull.head}`))) {
    throw new ApprovalError("Repository worktree registration and PR head branch do not match");
  }
  if (await runGit(worktree, ["branch", "--show-current"]) !== pull.head || await runGit(worktree, ["rev-parse", "HEAD"]) !== pull.headSha) {
    throw new ApprovalError("Recovered worktree branch or HEAD does not match the pull request");
  }
  if (await runGit(worktree, ["status", "--porcelain"])) throw new ApprovalError("Recovered worktree is not clean");
  const origin = await runGit(repo.path, ["remote", "get-url", "origin"]);
  validateGitHubRemote(origin);
  if (await runGit(worktree, ["remote", "get-url", "origin"]) !== origin) throw new ApprovalError("Recovered worktree origin does not match the selected repository");
  const task: RepoTask = {
    id, repoId: repo.id, repoName: repo.name, repoPath: repo.path, allowedRoot, branch: pull.head, baseBranch: pull.base,
    baseSha: await runGit(repo.path, ["rev-parse", "HEAD"]), originUrl: origin, worktreePath: worktree, worktreeRoot,
    worktreeAvailable: true, status: "pr_created", prompt: "", reviewReady: false, approvalState: "unavailable", validation: [], secretFindings: [],
    commitSha: pull.headSha, prUrl: pull.url, prNumber: pull.number, originalTaskAvailable: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoveryStatus: "needs_attention", worktreeStatus: "available",
  };
  registerRecoveredTask(task);
  return publicTask(task);
}

export async function fetchPullRequestDiff(task: RepoTask) {
  if (!task.prNumber) throw new Error("Pull request number is unavailable");
  const result = await checkedGh(["pr", "diff", String(task.prNumber), "--repo", repositoryName(task), "--patch"], task.worktreeAvailable ? task.worktreePath : task.repoPath);
  if (result.stdoutTruncated) throw new Error("PR diff exceeds the safe intake limit");
  return result.stdout;
}

export function parsePullRequestReview(viewJson: string, commentsJson: string, threadsJson: string, requiredResult: GhResult, now = new Date()): PullRequestReview {
  const view = parseObject(viewJson, "PR view");
  const number = positiveInteger(view.number, "PR number");
  const merged = typeof view.mergedAt === "string" && Boolean(view.mergedAt);
  const state = merged ? "MERGED" : oneOf(view.state, ["OPEN", "CLOSED"], "PR state");
  const checks = parseChecks(view.statusCheckRollup, requiredResult);
  const items: PullRequestReviewItem[] = [];
  const reviews = array(view.reviews);
  for (const [index, value] of reviews.entries()) {
    const review = object(value);
    const reviewState = text(review.state, "COMMENTED").toUpperCase();
    const body = boundedBody(review.body);
    const disposition = classifyDisposition({ reviewState: reviewState === "COMMENTED" && body ? "CHANGES_REQUESTED" : reviewState });
    items.push({
      id: `review:${text(review.id, String(index))}`,
      kind: "review",
      author: author(review.author),
      body,
      state: reviewState,
      disposition,
      reason: reviewState === "CHANGES_REQUESTED" ? "GitHub review requested changes" : disposition === "action_required" ? "Non-empty COMMENTED review requires human triage" : "Review does not request changes",
    });
  }
  for (const value of array(JSON.parse(commentsJson))) {
    const comment = object(value);
    items.push({
      id: `comment:${text(comment.id, randomUUID())}`,
      kind: "comment",
      author: author(comment.user),
      body: boundedBody(comment.body),
      path: optionalText(comment.path),
      line: optionalPositiveInteger(comment.line ?? comment.original_line),
      url: optionalText(comment.html_url),
      disposition: "informational",
      reason: "Comment requires technical validation; GitHub has not marked it blocking",
    });
  }
  const threadRoot = object(object(object(parseObject(threadsJson, "review threads").data).repository).pullRequest);
  const threadConnection = object(threadRoot.reviewThreads);
  if (object(threadConnection.pageInfo).hasNextPage === true) throw new Error("More than 100 review threads are not supported safely");
  const threadNodes = array(threadConnection.nodes);
  let unresolvedCount = 0;
  for (const [index, value] of threadNodes.entries()) {
    const thread = object(value);
    const resolved = thread.isResolved === true;
    if (!resolved) unresolvedCount += 1;
    const comments = array(object(thread.comments).nodes).map((entry) => object(entry));
    items.push({
      id: `thread:${text(thread.id, String(index))}`,
      kind: "thread",
      author: author(comments[0]?.author),
      body: boundedBody(comments.map((comment) => text(comment.body, "")).filter(Boolean).join("\n\n")),
      path: optionalText(thread.path),
      line: optionalPositiveInteger(thread.line ?? thread.originalLine),
      url: optionalText(comments[0]?.url),
      resolved,
      disposition: resolved ? "resolved" : "action_required",
      reason: resolved ? "GitHub review thread is resolved" : "GitHub review thread is unresolved",
    });
  }
  for (const check of checks.filter((value) => value.required && value.bucket === "fail")) {
    items.push({ id: `check:${check.name}`, kind: "check", author: "GitHub Checks", body: "", state: check.state, disposition: "blocking", reason: "Required check failed" });
  }
  if (items.length > MAX_REVIEW_ITEMS) throw new Error("PR review item count exceeds the safe intake limit");
  return {
    number,
    title: text(view.title),
    url: text(view.url),
    state,
    draft: view.isDraft === true,
    merged,
    base: text(view.baseRefName),
    head: text(view.headRefName),
    headSha: sha(view.headRefOid),
    mergeable: text(view.mergeable, "UNKNOWN"),
    mergeStateStatus: text(view.mergeStateStatus, "UNKNOWN"),
    changedFiles: array(view.files).map((value) => { const file = object(value); return { path: text(file.path), additions: nonnegative(file.additions), deletions: nonnegative(file.deletions) }; }),
    checks,
    items,
    reviewCount: reviews.length,
    unresolvedCount,
    fetchedAt: now.toISOString(),
  };
}

export async function validateExistingPullRequest(task: RepoTask, review: PullRequestReview, options: { allowDirty?: boolean } = {}) {
  await validatePullRequestIdentity(task, review, options);
  if (review.merged || review.state !== "OPEN") throw new Error("Merged or closed pull requests cannot enter review intake");
}

async function validatePullRequestIdentity(task: RepoTask, review: PullRequestReview, options: { allowDirty?: boolean; allowClosed?: boolean } = {}) {
  const remote = await validateOrigin(task);
  const expectedUrl = `https://github.com/${remote.owner}/${remote.repo}/pull/${task.prNumber}`;
  if (review.number !== task.prNumber || review.url !== expectedUrl || task.prUrl !== expectedUrl) throw new Error("Pull request repository or number does not match the task");
  if (!options.allowClosed && (review.merged || review.state !== "OPEN")) throw new Error("Merged or closed pull requests cannot enter review intake");
  if (review.base !== task.baseBranch) throw new Error("Pull request base branch does not match the task");
  if (review.head !== task.branch || !/^multiagents\/[0-9a-f-]{36}$/.test(review.head)) throw new Error("Pull request head branch does not match the task");
  if (!task.worktreeAvailable) {
    if (task.originalTaskAvailable) throw new Error("Review-only recovery state is invalid");
    if (await runGit(task.repoPath, ["branch", "--show-current"]) !== task.baseBranch || await runGit(task.repoPath, ["rev-parse", "HEAD"]) !== task.baseSha) throw new Error("Source/base branch changed after review-only recovery");
    return;
  }
  if (await runGit(task.worktreePath, ["branch", "--show-current"]) !== task.branch) throw new Error("Task worktree branch changed");
  const head = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
  if (!task.commitSha || head !== task.commitSha || review.headSha !== head) throw new Error("Task worktree, commit, and PR head SHA do not match");
  if (!options.allowDirty && await runGit(task.worktreePath, ["status", "--porcelain"])) throw new Error("Task worktree must be clean before review intake");
  if (await runGit(task.repoPath, ["branch", "--show-current"]) !== task.baseBranch || await runGit(task.repoPath, ["rev-parse", "HEAD"]) !== task.baseSha) throw new Error("Source/base branch changed after task creation");
}

export function classifyDisposition(input: { reviewState?: string; unresolved?: boolean; resolved?: boolean; requiredCheckBucket?: PullRequestCheck["bucket"] }): ReviewDisposition {
  if (input.requiredCheckBucket === "fail") return "blocking";
  if (input.resolved) return "resolved";
  if (input.reviewState === "CHANGES_REQUESTED" || input.unresolved) return "action_required";
  return "informational";
}

export function isPrReviewLockedForTests(taskId: string) { return isTaskLocked(taskId); }

async function validateReworkSafety(task: RepoTask, review: PullRequestReview) {
  await validateExistingPullRequest(task, review, { allowDirty: true });
  if (!task.reworkBaseSha || task.reworkBaseSha !== task.commitSha) throw new Error("Rework base commit is unavailable or stale");
  if (await runGit(task.worktreePath, ["ls-files", "-u"])) throw new Error("Merge conflict state is not allowed");
  if (await runGit(task.worktreePath, ["diff", "--name-only", "--diff-filter=U", "HEAD", "--"])) throw new Error("Merge conflicts must be resolved before approval");
  const validated = await validateRepository(task.repoId, task.allowedRoot);
  if (await realpath(validated.path) !== await realpath(task.repoPath)) throw new Error("Task and repository do not match");
  const root = await realpath(task.worktreeRoot);
  const worktree = await realpath(task.worktreePath);
  const rel = relative(root, worktree);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || worktree !== await realpath(join(root, task.repoId, task.id))) throw new Error("Task worktree path is invalid");
  const dotGit = await lstat(join(worktree, ".git"));
  if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw new Error("Unexpected .git entry in task worktree");
}

async function validateOrigin(task: RepoTask) {
  const current = await runGit(task.worktreePath, ["remote", "get-url", "origin"]);
  if (!task.originUrl || current !== task.originUrl) throw new Error("GitHub origin changed after task creation");
  return validateGitHubRemote(current);
}

function repositoryName(task: RepoTask) {
  if (!task.originUrl) throw new Error("GitHub origin is unavailable");
  const remote = validateGitHubRemote(task.originUrl);
  return `${remote.owner}/${remote.repo}`;
}

async function reviewFingerprint(task: RepoTask) {
  if (task.worktreeAvailable) return (await createDiffSnapshot(task)).hash;
  const [head, status] = await Promise.all([
    runGit(task.repoPath, ["rev-parse", "HEAD"]),
    runGit(task.repoPath, ["status", "--porcelain=v1", "-z"]),
  ]);
  return createHash("sha256").update(head).update("\0").update(status).digest("hex");
}

async function getTaskDiffForReview(task: RepoTask) {
  const diff = await getTaskDiff(task);
  return [diff.patch, diff.untrackedPatch].filter(Boolean).join("\n\n") || "(no revised diff)";
}

function requireTask(taskId: string) {
  const task = getTask(taskId);
  if (!task) throw new ApprovalError("Task not found", 404);
  return task;
}

function requireReworkApproval(task: RepoTask, input: ApprovalInput) {
  if (input.approved !== true) throw new ApprovalError("Explicit human approval is required", 400);
  if (!["awaiting_final_approval", "validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed"].includes(task.status) || task.approvalState !== "pending" || task.approvalPurpose !== "rework") {
    throw new ApprovalError("Revised diff is not awaiting approval");
  }
  if (!input.diffHash || input.diffHash !== task.diffHash || !input.approvalId || input.approvalId !== task.approvalId) throw new ApprovalError("Approval is invalid, stale, or already used");
}

function approvalInvalidated(task: RepoTask) {
  task.validation.push({ name: "Diff hash", status: "fail", detail: "MISMATCH" });
  task.approvalState = "invalidated";
  transitionTask(task, "approval_invalidated");
  task.error = "Approval invalidated because the revised worktree changed. Review the latest diff again.";
  return new ApprovalError(task.error);
}

function markPotentiallyAddressed(review: PullRequestReview): PullRequestReview {
  return { ...review, items: review.items.map((item) => item.kind === "thread" && !item.resolved ? { ...item, potentiallyAddressed: true } : item) };
}

async function pollPullRequestCi(task: RepoTask) {
  const started = Date.now();
  let review = await fetchPullRequestReview(task);
  while (Date.now() - started < CI_POLL_TIMEOUT_MS) {
    const required = review.checks.filter((check) => check.required);
    if (required.some((check) => check.bucket === "fail")) return { status: "fail" as const, review, message: "Required CI check failed. No merge was attempted." };
    if (required.every((check) => check.bucket === "pass" || check.bucket === "skipping")) return { status: "pass" as const, review, message: "Required checks passed." };
    await new Promise((resolve) => setTimeout(resolve, CI_POLL_INTERVAL_MS));
    review = await fetchPullRequestReview(task);
  }
  return { status: "pending" as const, review, message: "CI pending — verify on GitHub before merge." };
}

function parseChecks(value: unknown, requiredResult: GhResult): PullRequestCheck[] {
  const checks = array(value).map((entry): PullRequestCheck => {
    const check = object(entry);
    const state = text(check.conclusion ?? check.state ?? check.status, "UNKNOWN").toUpperCase();
    return { name: text(check.name ?? check.context, "Unnamed check"), state, bucket: checkBucket(state), required: false, workflow: optionalText(check.workflowName), link: optionalText(check.detailsUrl ?? check.targetUrl) };
  });
  const requiredNames = new Set<string>();
  const noRequired = /no required checks reported/i.test(requiredResult.stderr) || /no required checks reported/i.test(requiredResult.stdout);
  if (requiredResult.code !== 0 && !noRequired && !requiredResult.stdout.trim()) throw new Error("GitHub required checks fetch failed");
  if (!noRequired) {
    for (const line of requiredResult.stdout.split(/\r?\n/).filter(Boolean)) {
      const [name, state = ""] = line.split("\t");
      if (!name) continue;
      requiredNames.add(name);
      const existing = checks.find((check) => check.name === name);
      if (existing) existing.required = true;
      else checks.push({ name, state: state.toUpperCase(), bucket: checkBucket(state), required: true });
    }
  }
  for (const check of checks) if (requiredNames.has(check.name)) check.required = true;
  return checks;
}

function checkBucket(state: string): PullRequestCheck["bucket"] {
  const value = state.toUpperCase();
  if (["SUCCESS", "PASS", "PASSED", "NEUTRAL"].includes(value)) return "pass";
  if (["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value)) return "fail";
  if (["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"].includes(value)) return "pending";
  if (["SKIPPED", "STALE"].includes(value)) return "skipping";
  return "unknown";
}

async function checkedGh(args: readonly string[], cwd: string): Promise<GhResult> {
  const result = await gh(args, cwd);
  if (result.code !== 0) throw new Error("GitHub CLI read failed");
  if (result.stdoutTruncated) throw new Error("GitHub response exceeds the safe output limit");
  return result;
}

async function gh(args: readonly string[], cwd: string): Promise<GhResult> {
  const result = await runFixedProcess(GH_BINARY, args, cwd, COMMAND_TIMEOUT_MS);
  return { stdout: result.stdout, stderr: result.stderr, code: result.code, stdoutTruncated: result.stdoutTruncated };
}

const THREAD_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line originalLine comments(first:100){nodes{author{login} body url}}}pageInfo{hasNextPage}}}}}`;

function parseObject(value: string, label: string) {
  try { return object(JSON.parse(value)); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function optionalText(value: unknown) { const result = text(value); return result || undefined; }
function author(value: unknown) { const item = object(value); return text(item.login ?? item.name, "unknown"); }
function boundedBody(value: unknown) { return Array.from(text(value)).slice(0, MAX_REVIEW_BODY_CHARS).join(""); }
function positiveInteger(value: unknown, label: string) { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid`); return Number(value); }
function optionalPositiveInteger(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
function nonnegative(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function sha(value: unknown) { const result = text(value); if (!/^[0-9a-f]{40}$/.test(result)) throw new Error("PR head SHA is invalid"); return result; }
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T { if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${label} is invalid`); return value as T; }
function safeError(error: unknown, fallback: string) { return error instanceof Error ? error.message.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]") : fallback; }
