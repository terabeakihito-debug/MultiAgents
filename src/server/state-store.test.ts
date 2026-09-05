import { mkdir, mkdtemp, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowStep } from "../agents/types";
import { approveAndCreatePullRequest, prepareApproval, retryPullRequest } from "./pull-request";
import { runGit } from "./git";
import { SCHEMA_VERSION, StateStore, replaceStateStoreForTests } from "./state-store";
import {
  beginTaskReview,
  clearTasksForTests,
  completeTaskReview,
  createTask,
  deleteTask,
  getTask,
  persistTask,
  reloadTasksFromStoreForTests,
  resumeTask,
  type RepoTask,
} from "./tasks";

let testRoot: string;
let store: StateStore;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "multiagents-state-"));
  store = new StateStore(join(testRoot, "data", "state.db"));
  replaceStateStoreForTests(store);
  clearTasksForTests();
});

afterEach(() => {
  clearTasksForTests();
  replaceStateStoreForTests(new StateStore(":memory:"));
});

async function repositoryTask(name = "project") {
  const allowedRoot = join(testRoot, "code");
  const repoPath = join(allowedRoot, name);
  await mkdir(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test"]);
  await writeFile(join(repoPath, "README.md"), "initial\n");
  await runGit(repoPath, ["add", "README.md"]);
  await runGit(repoPath, ["commit", "-m", "initial"]);
  await runGit(repoPath, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  const task = await createTask(name, { allowedRoot, worktreeRoot: join(testRoot, "worktrees") });
  return { allowedRoot, repoPath, task };
}

const steps = (): FlowStep[] => [
  { id: "codex_draft", agent: "codex", role: "draft", status: "completed", output: "draft", durationMs: 10 },
  { id: "cursor_review", agent: "cursor", role: "review", status: "completed", output: "cursor", durationMs: 20 },
  { id: "claude_review", agent: "claude", role: "review", status: "stale", output: "claude", error: "Upstream changed" },
  { id: "codex_final", agent: "codex", role: "final", status: "stale", output: "final", error: "Upstream changed" },
];

describe("Phase 7 SQLite state", () => {
  it("creates schema v1 with private directory and database permissions", async () => {
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect((await stat(join(testRoot, "data"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(testRoot, "data", "state.db"))).mode & 0o777).toBe(0o600);
  });

  it("reloads task, flow steps, rerun stale state, prompt, and diff hash", async () => {
    const { task } = await repositoryTask();
    await writeFile(join(task.worktreePath, "README.md"), "initial\nchange\n");
    beginTaskReview(task, "Persist this prompt");
    task.flowId = "flow-1"; task.flowStatus = "completed"; task.flowSteps = steps(); task.finalOutput = "final";
    completeTaskReview(task, true);
    const prepared = await prepareApproval(task);
    expect(prepared.approval?.diffHash).toBeTruthy();

    reloadTasksFromStoreForTests();
    const restored = getTask(task.id)!;
    expect(restored.prompt).toBe("Persist this prompt");
    expect(restored.flowSteps?.map((step) => step.status)).toEqual(["completed", "completed", "stale", "stale"]);
    expect(restored.diffHash).toBe(task.diffHash);
    expect(restored.approvalState).toBe("invalidated");
    expect(restored.status).toBe("approval_invalidated");
  });

  it("recovers a matching registered worktree but never reuses approval", async () => {
    const { allowedRoot, task } = await repositoryTask();
    await writeFile(join(task.worktreePath, "README.md"), "changed\n");
    beginTaskReview(task, "Safe change"); completeTaskReview(task, true); await prepareApproval(task);
    reloadTasksFromStoreForTests();
    const restored = await resumeTask(task.id, { allowedRoot, worktreeRoot: task.worktreeRoot });
    expect(restored).toMatchObject({ recoveryStatus: "needs_attention", worktreeStatus: "available", approvalState: "invalidated" });
    expect(restored?.approvalId).toBeUndefined();
  });

  it("classifies a missing worktree as orphaned without recreating it", async () => {
    const { allowedRoot, task } = await repositoryTask();
    await rename(task.worktreePath, `${task.worktreePath}-missing`);
    reloadTasksFromStoreForTests();
    const restored = await resumeTask(task.id, { allowedRoot, worktreeRoot: task.worktreeRoot });
    expect(restored).toMatchObject({ recoveryStatus: "orphaned", worktreeStatus: "missing", worktreeAvailable: false });
    expect(restored?.recoveryMessage).toContain("Manual recovery required");
  });

  it("classifies wrong branches and saved repository path escapes as invalid", async () => {
    const { allowedRoot, task } = await repositoryTask();
    await runGit(task.worktreePath, ["switch", "-c", "wrong-branch"]);
    reloadTasksFromStoreForTests();
    expect(await resumeTask(task.id, { allowedRoot, worktreeRoot: task.worktreeRoot })).toMatchObject({ recoveryStatus: "invalid", worktreeStatus: "invalid" });

    const second = await repositoryTask("project2");
    second.task.repoPath = testRoot;
    persistTask(second.task);
    reloadTasksFromStoreForTests();
    expect(await resumeTask(second.task.id, { allowedRoot: second.allowedRoot, worktreeRoot: second.task.worktreeRoot })).toMatchObject({ recoveryStatus: "invalid" });
  });

  it("retains a PR-only orphan for read-only review and persists archive cleanup", async () => {
    const { allowedRoot, task } = await repositoryTask();
    task.prNumber = 7; task.prUrl = "https://github.com/example/project/pull/7"; task.commitSha = task.baseSha;
    persistTask(task);
    await rename(task.worktreePath, `${task.worktreePath}-missing`);
    reloadTasksFromStoreForTests();
    const restored = await resumeTask(task.id, { allowedRoot, worktreeRoot: task.worktreeRoot });
    expect(restored).toMatchObject({ recoveryStatus: "orphaned", prNumber: 7, worktreeAvailable: false });
    expect(restored?.recoveryMessage).toContain("PR review can be inspected");

    const archived = await repositoryTask("project2");
    await deleteTask(archived.task.id);
    reloadTasksFromStoreForTests();
    expect(getTask(archived.task.id)).toMatchObject({ status: "archived", worktreeStatus: "removed" });
  });

  it("rolls back a task insert when a flow-step write fails", async () => {
    const { task } = await repositoryTask();
    const clone = { ...task, id: "11111111-1111-1111-1111-111111111111", flowSteps: steps() } as RepoTask;
    const internal = store as unknown as { replaceFlowSteps: (taskId: string, values: FlowStep[]) => void };
    const original = internal.replaceFlowSteps.bind(store);
    internal.replaceFlowSteps = () => { throw new Error("injected failure"); };
    expect(() => store.saveTask(clone)).toThrow("injected failure");
    internal.replaceFlowSteps = original;
    expect(store.loadTasks().some((item) => item.id === clone.id)).toBe(false);
  });

  it("keeps commit and PR idempotency barriers after a process-memory reload", async () => {
    const { task } = await repositoryTask();
    await writeFile(join(task.worktreePath, "README.md"), "changed\n");
    beginTaskReview(task, "Safe change"); completeTaskReview(task, true);
    const prepared = await prepareApproval(task);
    const input = { approved: true as const, diffHash: prepared.approval!.diffHash!, approvalId: prepared.approval!.approvalId! };
    const commit = vi.fn(async (value: RepoTask) => { await runGit(value.worktreePath, ["add", "--all"]); await runGit(value.worktreePath, ["commit", "-m", "saved"]); });
    const createPr = vi.fn(async () => ({ url: "https://github.com/example/project/pull/42", number: 42 }));
    await approveAndCreatePullRequest(task.id, input, {
      stage: async () => undefined, commit, push: async () => undefined, checkGhAuth: async () => undefined,
      createPr, checkDependencies: async () => undefined, runValidation: async () => undefined,
    });
    expect(commit).toHaveBeenCalledOnce(); expect(createPr).toHaveBeenCalledOnce();
    reloadTasksFromStoreForTests();
    const commitAgain = vi.fn(async () => undefined);
    await expect(approveAndCreatePullRequest(task.id, input, { commit: commitAgain })).rejects.toThrow("not awaiting approval");
    expect(commitAgain).not.toHaveBeenCalled();
    const createAgain = vi.fn(async () => ({ url: "https://github.com/example/project/pull/99", number: 99 }));
    await expect(retryPullRequest(task.id, { createPr: createAgain })).resolves.toMatchObject({ prNumber: 42 });
    expect(createAgain).not.toHaveBeenCalled();
  });
});
