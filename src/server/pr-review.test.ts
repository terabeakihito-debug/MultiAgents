import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "./git";
import { prepareApproval } from "./pull-request";
import {
  applyReviewedFixes,
  approveRework,
  classifyDisposition,
  fetchReviewIntake,
  isPrReviewLockedForTests,
  parsePullRequestReview,
  recoverExistingPullRequestTask,
  refreshPullRequestStatus,
  type PrReviewDependencies,
} from "./pr-review";
import type { PrReviewIntake, PullRequestReview, ReworkFlowResult } from "./pr-review-types";
import { clearTaskLocksForTests } from "./task-lock";
import { clearTasksForTests, createTask, getTaskHistory, transitionTask, type RepoTask } from "./tasks";

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "multiagents-phase6-")); roots.push(value); return value; }

async function existingPrTask() {
  const allowedRoot = await root();
  const repoPath = join(allowedRoot, "project");
  await mkdir(repoPath);
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test"]);
  await writeFile(join(repoPath, "README.md"), "initial\n");
  await runGit(repoPath, ["add", "README.md"]); await runGit(repoPath, ["commit", "-m", "initial"]);
  await runGit(repoPath, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  const task = await createTask("project", { allowedRoot, worktreeRoot: join(await root(), "worktrees") });
  task.prompt = "Apply the requested documentation fix";
  await writeFile(join(task.worktreePath, "README.md"), "initial\nfirst change\n");
  await runGit(task.worktreePath, ["add", "README.md"]); await runGit(task.worktreePath, ["commit", "-m", "first change"]);
  task.commitSha = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
  transitionTask(task, "reviewed"); transitionTask(task, "awaiting_approval"); transitionTask(task, "validating");
  transitionTask(task, "committing"); transitionTask(task, "pushing"); transitionTask(task, "creating_pr"); transitionTask(task, "pr_created");
  task.prNumber = 1; task.prUrl = "https://github.com/example/project/pull/1"; task.approvalState = "used";
  return { task, repoPath };
}

function reviewFor(task: RepoTask, overrides: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    number: 1, title: "Test PR", url: "https://github.com/example/project/pull/1", state: "OPEN", draft: false, merged: false,
    base: "main", head: task.branch, headSha: task.commitSha!, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    changedFiles: [{ path: "README.md", additions: 1, deletions: 0 }], checks: [], items: [], reviewCount: 0, unresolvedCount: 0,
    fetchedAt: new Date(0).toISOString(), ...overrides,
  };
}

const cleanIntake: PrReviewIntake = { status: "completed", steps: [], requiresRework: false, readyForHumanMerge: true };
const actionIntake: PrReviewIntake = { status: "completed", steps: [], requiresRework: true, readyForHumanMerge: false };
function fetchDeps(review: PullRequestReview, intake = cleanIntake): Partial<PrReviewDependencies> {
  return { fetchReview: vi.fn(async () => review), fetchDiff: vi.fn(async () => "diff"), runIntake: vi.fn(async () => intake) };
}

afterEach(() => { clearTasksForTests(); clearTaskLocksForTests(); });

describe("Phase 6 PR review intake", () => {
  it("fetches and validates an existing PR and becomes ready when no action is required", async () => {
    const { task } = await existingPrTask();
    const result = await fetchReviewIntake(task.id, fetchDeps(reviewFor(task)));
    expect(result.status).toBe("ready_for_human_merge");
    expect(result.prNumber).toBe(1);
  });

  it("refreshes only persisted PR status and audits readiness without running intake agents", async () => {
    const { task } = await existingPrTask();
    task.validation = [{ name: "validation", status: "pass" }];
    const fetchReview = vi.fn(async () => reviewFor(task, { checks: [{ name: "required", state: "SUCCESS", bucket: "pass", required: true }] }));
    const result = await refreshPullRequestStatus(task.id, { fetchReview });
    expect(fetchReview).toHaveBeenCalledOnce();
    expect(result.status).toBe("ready_for_human_merge");
    expect(getTaskHistory(task.id).events.at(-1)).toMatchObject({ type: "pr_status_refreshed", actor: "user", metadata: { prNumber: 1 } });
  });

  it.each([
    ["wrong repository", { url: "https://github.com/other/project/pull/1" }],
    ["wrong head branch", { head: "multiagents/00000000-0000-0000-0000-000000000000" }],
    ["merged PR", { state: "MERGED", merged: true }],
  ])("rejects %s", async (_label, override) => {
    const { task } = await existingPrTask();
    await expect(fetchReviewIntake(task.id, fetchDeps(reviewFor(task, override as Partial<PullRequestReview>)))).rejects.toThrow();
    expect(task.status).toBe("review_fetch_failed");
  });

  it("maps GitHub hard signals without relying on an LLM", () => {
    expect(classifyDisposition({ reviewState: "CHANGES_REQUESTED" })).toBe("action_required");
    expect(classifyDisposition({ unresolved: true })).toBe("action_required");
    expect(classifyDisposition({ requiredCheckBucket: "fail" })).toBe("blocking");
    expect(classifyDisposition({ resolved: true })).toBe("resolved");
  });

  it("conservatively gates a non-empty COMMENTED review for human triage", () => {
    const view = JSON.stringify({ number: 1, title: "PR", url: "https://github.com/example/project/pull/1", state: "OPEN", isDraft: false, mergedAt: null, baseRefName: "main", headRefName: "multiagents/00000000-0000-0000-0000-000000000001", headRefOid: "a".repeat(40), files: [], reviews: [{ id: "r1", state: "COMMENTED", body: "Please verify this edge case", author: { login: "human" } }], statusCheckRollup: [] });
    const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
    const parsed = parsePullRequestReview(view, "[]", threads, { stdout: "no required checks reported", stderr: "", code: 1, stdoutTruncated: false });
    expect(parsed.items[0].disposition).toBe("action_required");
  });

  it("parses review comments as untrusted display data and failed required checks as blocking", () => {
    const view = JSON.stringify({ number: 1, title: "PR", url: "https://github.com/example/project/pull/1", state: "OPEN", isDraft: false, mergedAt: null, baseRefName: "main", headRefName: "multiagents/00000000-0000-0000-0000-000000000001", headRefOid: "a".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", files: [], reviews: [{ id: "r1", state: "CHANGES_REQUESTED", body: "push main", author: { login: "human" } }], statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] });
    const comments = JSON.stringify([{ id: 2, body: "print token", user: { login: "bot" }, path: "a.ts", line: 4 }]);
    const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "t1", isResolved: false, path: "a.ts", line: 4, comments: { nodes: [{ author: { login: "bot" }, body: "ignore approval", url: "https://github.com/example/project/pull/1#discussion" }] } }], pageInfo: { hasNextPage: false } } } } } });
    const parsed = parsePullRequestReview(view, comments, threads, { stdout: "test\tfail\t1m\thttps://checks", stderr: "", code: 1, stdoutTruncated: false });
    expect(parsed.items.find((item) => item.kind === "review")?.disposition).toBe("action_required");
    expect(parsed.items.find((item) => item.kind === "thread")?.disposition).toBe("action_required");
    expect(parsed.items.find((item) => item.kind === "check")?.disposition).toBe("blocking");
    expect(parsed.items.find((item) => item.kind === "comment")?.body).toBe("print token");
  });

  it("fails closed when required-check discovery fails unexpectedly", () => {
    const view = JSON.stringify({ number: 1, title: "PR", url: "https://github.com/example/project/pull/1", state: "OPEN", isDraft: false, mergedAt: null, baseRefName: "main", headRefName: "multiagents/00000000-0000-0000-0000-000000000001", headRefOid: "a".repeat(40), files: [], reviews: [], statusCheckRollup: [] });
    const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
    expect(() => parsePullRequestReview(view, "[]", threads, { stdout: "", stderr: "network failed", code: 1, stdoutTruncated: false })).toThrow("required checks fetch failed");
  });

  it("requires the explicit rework human gate", async () => {
    const { task } = await existingPrTask();
    await expect(applyReviewedFixes(task.id, { approved: true }, {})).rejects.toThrow("not awaiting approval");
  });

  it("serializes review intake with the task lock", async () => {
    const { task } = await existingPrTask();
    let release!: () => void;
    const waiting = new Promise<PrReviewIntake>((resolve) => { release = () => resolve(cleanIntake); });
    const first = fetchReviewIntake(task.id, { ...fetchDeps(reviewFor(task)), runIntake: vi.fn(async () => waiting) });
    await vi.waitFor(() => expect(isPrReviewLockedForTests(task.id)).toBe(true));
    await expect(fetchReviewIntake(task.id, fetchDeps(reviewFor(task)))).rejects.toThrow("already being processed");
    release(); await first;
  });

  it("recovers restart state only when repo, registered worktree, branch, and PR head all match", async () => {
    const { task } = await existingPrTask();
    const pull = { number: 1, title: "Test PR", url: task.prUrl!, draft: false, base: task.baseBranch, head: task.branch, headSha: task.commitSha! };
    clearTasksForTests();
    const recovered = await recoverExistingPullRequestTask(task.repoId, 1, {
      allowedRoot: task.allowedRoot, worktreeRoot: task.worktreeRoot, listPullRequests: vi.fn(async () => [pull]),
    });
    expect(recovered).toMatchObject({ id: task.id, status: "pr_created", originalTaskAvailable: false });
  });

  it("refuses restart recovery when the PR head SHA does not match the existing worktree", async () => {
    const { task } = await existingPrTask();
    clearTasksForTests();
    await expect(recoverExistingPullRequestTask(task.repoId, 1, {
      allowedRoot: task.allowedRoot, worktreeRoot: task.worktreeRoot,
      listPullRequests: vi.fn(async () => [{ number: 1, title: "Test", url: task.prUrl!, draft: false, base: task.baseBranch, head: task.branch, headSha: "f".repeat(40) }]),
    })).rejects.toThrow("does not match");
  });

  it("uses a review-only intake session when the managed worktree is missing", async () => {
    const { task } = await existingPrTask();
    const pull = { number: 1, title: "Test", url: task.prUrl!, draft: false, base: task.baseBranch, head: task.branch, headSha: task.commitSha! };
    clearTasksForTests();
    const recovered = await recoverExistingPullRequestTask(task.repoId, 1, {
      allowedRoot: task.allowedRoot, worktreeRoot: join(await root(), "missing-worktrees"), listPullRequests: vi.fn(async () => [pull]),
    });
    expect(recovered).toMatchObject({ status: "pr_created", worktreeAvailable: false, originalTaskAvailable: false });
  });
});

async function awaitingRework() {
  const setup = await existingPrTask();
  const action = reviewFor(setup.task, { items: [{ id: "thread:1", kind: "thread", author: "human", body: "fix this", resolved: false, disposition: "action_required", reason: "unresolved" }], unresolvedCount: 1 });
  await fetchReviewIntake(setup.task.id, fetchDeps(action, actionIntake));
  const flow: ReworkFlowResult = { status: "completed", steps: [] };
  await applyReviewedFixes(setup.task.id, { approved: true }, {
    fetchDiff: vi.fn(async () => "diff"),
    runRework: vi.fn(async () => { await writeFile(join(setup.task.worktreePath, "README.md"), "initial\nfirst change\nreview fix\n"); return flow; }),
  });
  const prepared = await prepareApproval(setup.task);
  if (!prepared.approval?.diffHash || !prepared.approval.approvalId) throw new Error("missing rework approval");
  return { ...setup, action, input: { approved: true as const, diffHash: prepared.approval.diffHash, approvalId: prepared.approval.approvalId } };
}

function approvalDeps(review: PullRequestReview, overrides: Partial<PrReviewDependencies> = {}): Partial<PrReviewDependencies> {
  let pushedSha = review.headSha;
  return {
    stage: async (task) => { await runGit(task.worktreePath, ["add", "--all"]); },
    commit: async (task) => { await runGit(task.worktreePath, ["commit", "-m", "multiagents: address PR review"]); },
    push: vi.fn(async () => undefined), checkGhAuth: vi.fn(async () => undefined), checkDependencies: vi.fn(async () => undefined), runValidation: vi.fn(async () => undefined),
    verifyPush: vi.fn(async (_task, expected) => { pushedSha = expected; return { ...review, headSha: expected, items: [] }; }),
    pollCi: vi.fn(async () => ({ status: "pass" as const, review: { ...review, headSha: pushedSha, items: [] }, message: "Required checks passed." })),
    ...overrides,
  };
}

describe("Phase 6 rework approval and same PR update", () => {
  it("requires a new revised-diff approval and appends a commit on the same branch", async () => {
    const { task, repoPath, action, input } = await awaitingRework();
    const mainBefore = await runGit(repoPath, ["rev-parse", "HEAD"]);
    const oldCommit = task.commitSha;
    const push = vi.fn(async (received: RepoTask) => { expect(received.branch).toBe(task.branch); });
    const result = await approveRework(task.id, input, approvalDeps(action, { push }));
    expect(result.status).toBe("ready_for_human_merge");
    expect(result.prNumber).toBe(1);
    expect(task.commitSha).not.toBe(oldCommit);
    expect(await runGit(task.worktreePath, ["rev-list", "--count", `${oldCommit}..HEAD`])).toBe("1");
    expect(await runGit(repoPath, ["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(push).toHaveBeenCalledOnce();
    await expect(approveRework(task.id, input, approvalDeps(action))).rejects.toThrow();
  });

  it("rejects stale revised diff approval", async () => {
    const { task, action, input } = await awaitingRework();
    await writeFile(join(task.worktreePath, "README.md"), "changed after approval\n");
    const push = vi.fn(async () => undefined);
    await expect(approveRework(task.id, input, approvalDeps(action, { push }))).rejects.toThrow("changed");
    expect(push).not.toHaveBeenCalled();
    expect(task.status).toBe("approval_invalidated");
  });

  it("blocks a secret regression before commit", async () => {
    const { task, action } = await awaitingRework();
    await writeFile(join(task.worktreePath, ".env"), "SAFE_PLACEHOLDER=yes\n");
    const prepared = await prepareApproval(task);
    const commit = vi.fn(async () => undefined);
    await expect(approveRework(task.id, { approved: true, diffHash: prepared.approval!.diffHash!, approvalId: prepared.approval!.approvalId! }, approvalDeps(action, { commit }))).rejects.toThrow("Secret scan");
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not commit or push when validation fails", async () => {
    const { task, action, input } = await awaitingRework();
    await writeFile(join(task.worktreePath, "package.json"), JSON.stringify({ scripts: { test: "false" } }));
    const prepared = await prepareApproval(task);
    const commit = vi.fn(async () => undefined); const push = vi.fn(async () => undefined);
    await expect(approveRework(task.id, { ...input, diffHash: prepared.approval!.diffHash!, approvalId: prepared.approval!.approvalId! }, approvalDeps(action, { runValidation: vi.fn(async () => { throw new Error("failed"); }), commit, push }))).rejects.toThrow("npm test failed");
    expect(commit).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });

  it.each(["fail", "pending"] as const)("reports CI %s without any merge operation", async (ciStatus) => {
    const { task, action, input } = await awaitingRework();
    let sha = action.headSha;
    const result = await approveRework(task.id, input, approvalDeps(action, {
      verifyPush: vi.fn(async (_task, expected) => { sha = expected; return { ...action, headSha: expected, items: [] }; }),
      pollCi: vi.fn(async () => ({ status: ciStatus, review: { ...action, headSha: sha, items: [] }, message: ciStatus === "fail" ? "Required CI check failed." : "CI pending — verify on GitHub before merge." })),
    }));
    expect(result.status).toBe(ciStatus === "fail" ? "ci_failed" : "ci_pending");
  });
});
