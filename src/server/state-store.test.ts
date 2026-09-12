import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneGitSeedFixture, createGitSeedFixture, type GitSeedFixture } from "../../test/git-seed-fixture";
import type { AgentAdapter, AgentId, AgentResult, FlowStep, RerunnableStepId } from "../agents/types";
import { reconstructReviewRerunRequest, rerunReviewStep } from "../flows/review-rerun";
import { approveAndCreatePullRequest, prepareApproval, retryPullRequest } from "./pull-request";
import { runGit } from "./git";
import { SCHEMA_VERSION, StateStore, replaceStateStoreForTests } from "./state-store";
import { acquireTaskLock, isTaskLocked, releaseTaskLock } from "./task-lock";
import {
  beginTaskReview,
  beginTaskRerun,
  clearTasksForTests,
  completeTaskReview,
  createTask,
  deleteTask,
  getTask,
  getTaskHistory,
  persistTask,
  recordApprovalEvent,
  recordFlowEvent,
  recordAgentLifecycle,
  recordTaskEvent,
  reloadTasksFromStoreForTests,
  resumeTask,
  type RepoTask,
} from "./tasks";

let testRoot: string;
let store: StateStore;
let gitSeed: GitSeedFixture;

beforeAll(async () => { gitSeed = await createGitSeedFixture({ "README.md": "initial\n" }); });
afterAll(async () => { await gitSeed.cleanup(); });

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "multiagents-state-"));
  store = new StateStore(join(testRoot, "data", "state.db"));
  replaceStateStoreForTests(store);
  clearTasksForTests();
});

afterEach(async () => {
  clearTasksForTests();
  replaceStateStoreForTests(new StateStore(":memory:"));
  await rm(testRoot, { recursive: true, force: true });
});

async function repositoryTask(name = "project") {
  const allowedRoot = join(testRoot, "code");
  const repoPath = join(allowedRoot, name);
  await cloneGitSeedFixture(gitSeed, repoPath, "https://github.com/example/project.git");
  const task = await createTask(name, { allowedRoot, worktreeRoot: join(testRoot, "worktrees") });
  return { allowedRoot, repoPath, task };
}

const steps = (): FlowStep[] => [
  { id: "codex_draft", agent: "codex", role: "draft", status: "completed", output: "draft", durationMs: 10 },
  { id: "cursor_review", agent: "cursor", role: "review", status: "completed", output: "cursor", durationMs: 20 },
  { id: "claude_review", agent: "claude", role: "review", status: "stale", output: "claude", error: "Upstream changed" },
  { id: "codex_final", agent: "codex", role: "final", status: "stale", output: "final", error: "Upstream changed" },
];

describe("Phase 8 SQLite state and audit history", () => {
  it("recovers a persisted draft budget failure through the complete manual rerun chain", async () => {
    const { task } = await repositoryTask();
    const flowId = "recovery-flow";
    const initialSteps: FlowStep[] = [
      { id: "codex_draft", agent: "codex", role: "draft", status: "error", output: "", error: "Review step budget exhausted." },
      { id: "cursor_review", agent: "cursor", role: "review", status: "skipped", output: "", error: "Codex draft failed" },
      { id: "claude_review", agent: "claude", role: "review", status: "skipped", output: "", error: "Codex draft failed" },
      { id: "codex_final", agent: "codex", role: "final", status: "skipped", output: "", error: "Codex draft failed" },
    ];
    beginTaskReview(task, "Recover the interrupted review");
    recordFlowEvent(task, { type: "flow_started", flowId, timestamp: "2026-01-01T00:00:00.000Z" });
    recordFlowEvent(task, { type: "flow_completed", flowId, result: { flowId, status: "error", steps: initialSteps, finalOutput: "" } });

    const calls: Record<AgentId, number> = { codex: 0, cursor: 0, claude: 0 };
    const adapters: Record<AgentId, AgentAdapter> = {
      codex: { id: "codex", name: "codex", run: async (): Promise<AgentResult> => ({ agent: "codex", status: "completed", output: ++calls.codex === 1 ? "draft recovered" : "final recovered" }) },
      cursor: { id: "cursor", name: "cursor", run: async (): Promise<AgentResult> => ({ agent: "cursor", status: "completed", output: (++calls.cursor, "cursor recovered") }) },
      claude: { id: "claude", name: "claude", run: async (): Promise<AgentResult> => ({ agent: "claude", status: "completed", output: (++calls.claude, "claude recovered") }) },
    };
    const rerun = async (stepId: RerunnableStepId) => {
      const persisted = getTask(task.id)!;
      const request = reconstructReviewRerunRequest(persisted, stepId);
      if ("error" in request) throw new Error(request.error);
      beginTaskRerun(task, task.prompt);
      const result = await rerunReviewStep(request, { agents: adapters, onEvent: (event) => recordFlowEvent(task, event) });
      completeTaskReview(task, result.status === "completed" && result.stepId === "codex_final" && result.steps[3]?.status === "completed");
      return result;
    };

    const draft = await rerun("codex_draft");
    expect(draft.steps.map((step) => step.status)).toEqual(["completed", "stale", "stale", "stale"]);
    expect(calls).toEqual({ codex: 1, cursor: 0, claude: 0 });
    expect(reconstructReviewRerunRequest(getTask(task.id)!, "claude_review")).toEqual({ error: "Missing usable upstream data: cursor_review" });

    await rerun("cursor_review");
    await rerun("claude_review");
    const final = await rerun("codex_final");

    expect(final.steps.every((step) => step.status === "completed")).toBe(true);
    expect(calls).toEqual({ codex: 2, cursor: 1, claude: 1 });
    expect(task.status).toBe("awaiting_approval");
    expect(task.reviewReady).toBe(true);
    reloadTasksFromStoreForTests();
    expect(getTask(task.id)).toMatchObject({
      status: "awaiting_approval",
      reviewReady: true,
      flowSteps: [
        { id: "codex_draft", status: "completed", output: "draft recovered" },
        { id: "cursor_review", status: "completed", output: "cursor recovered" },
        { id: "claude_review", status: "completed", output: "claude recovered" },
        { id: "codex_final", status: "completed", output: "final recovered" },
      ],
    });
    expect(getTaskHistory(task.id).events.filter((event) => event.type === "step_rerun")).toHaveLength(4);
  });

  it("releases the cleanup lease when cleanup persistence fails", async () => {
    const { task } = await repositoryTask();
    const save = vi.spyOn(store, "saveTask").mockImplementation(() => { throw new Error("injected SQLITE_FULL"); });
    try {
      await expect(deleteTask(task.id)).rejects.toThrow("injected SQLITE_FULL");
      expect(isTaskLocked(task.id)).toBe(false);
      const next = acquireTaskLock(task.id);
      expect(next).toBeTruthy();
      if (next) releaseTaskLock(task.id, next);
    } finally { save.mockRestore(); }
  });

  it("creates schema v2 with private directory and database permissions", async () => {
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect((await stat(join(testRoot, "data"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(testRoot, "data", "state.db"))).mode & 0o777).toBe(0o600);
  });

  it("appends task events in insertion order and persists them after reload", async () => {
    const { task } = await repositoryTask();
    recordTaskEvent(task, "flow_started", "system", { createdAt: "2026-01-01T00:00:02.000Z", status: "running" });
    recordTaskEvent(task, "flow_completed", "system", { createdAt: "2026-01-01T00:00:01.000Z", status: "completed" });
    expect(getTaskHistory(task.id).events.map((event) => event.type)).toEqual(["task_created", "profile_snapshot_created", "template_snapshot_created", "flow_started", "flow_completed"]);
    reloadTasksFromStoreForTests();
    expect(getTaskHistory(task.id).events.map((event) => event.type)).toEqual(["task_created", "profile_snapshot_created", "template_snapshot_created", "flow_started", "flow_completed"]);
  });

  it("persists the strict content-free agent lifecycle schema and rejects body-like fields", async () => {
    const { task } = await repositoryTask();
    const telemetry = {
      spawnedAt: "2026-01-01T00:00:00.000Z", timeoutRequestedAt: "2026-01-01T00:02:00.000Z",
      sigtermRequestedAt: "2026-01-01T00:02:00.000Z", sigtermSentAt: "2026-01-01T00:02:00.001Z",
      childClosedAt: "2026-01-01T00:02:00.010Z", exitSignal: "SIGTERM" as const,
      stdoutBytes: 12, stderrBytes: 34, stdoutFirstByteAt: "2026-01-01T00:00:01.000Z", stdoutLastByteAt: "2026-01-01T00:01:59.000Z",
      terminationMethod: "term_only" as const, terminationReason: "agent_deadline_exceeded" as const,
    };
    recordAgentLifecycle(task, "cursor", telemetry, "cursor_review");
    recordAgentLifecycle(task, "cursor", { ...telemetry, terminationReason: "step_budget_exhausted" }, "cursor_review");
    const event = getTaskHistory(task.id).events.at(-1)!;
    expect(event).toMatchObject({ type: "agent_lifecycle_recorded", actor: "cursor", stepId: "cursor_review", metadata: { lifecycle: { ...telemetry, terminationReason: "step_budget_exhausted" } } });
    expect(JSON.stringify(event.metadata)).not.toContain("prompt");
    expect(() => store.appendTaskEvent(task.id, {
      type: "agent_lifecycle_recorded", actor: "cursor",
      metadata: { lifecycle: { ...telemetry, stdoutText: "repository-derived text" } } as never,
    })).toThrow("forbidden");
    expect(() => store.appendTaskEvent(task.id, {
      type: "agent_lifecycle_recorded", actor: "cursor",
      metadata: { lifecycle: { ...telemetry, terminationReason: "unknown_reason" } } as never,
    })).toThrow("invalid");
  });

  it("increments step versions on rerun and preserves the old output", async () => {
    const { task } = await repositoryTask();
    const first = { ...steps()[1], status: "completed" as const, output: "cursor v1", completedAt: "2026-01-01T00:00:01.000Z" };
    recordFlowEvent(task, { type: "step_completed", flowId: "flow-1", step: first });
    recordFlowEvent(task, { type: "rerun_started", flowId: "flow-1", rerunId: "rerun-1", stepId: "cursor_review", timestamp: "2026-01-01T00:00:02.000Z" });
    const second = { ...first, output: "cursor v2", completedAt: "2026-01-01T00:00:03.000Z" };
    recordFlowEvent(task, { type: "rerun_step_completed", flowId: "flow-1", rerunId: "rerun-1", step: second });
    const versions = getTaskHistory(task.id).stepVersions.filter((version) => version.stepId === "cursor_review");
    expect(versions.map(({ version, output }) => ({ version, output }))).toEqual([{ version: 1, output: "cursor v1" }, { version: 2, output: "cursor v2" }]);
    expect(getTaskHistory(task.id).events.some((event) => event.type === "step_rerun")).toBe(true);
  });

  it("keeps diff and approval histories append-only", async () => {
    const { task } = await repositoryTask();
    store.appendDiffVersion(task.id, { diffHash: "a".repeat(64), changedFileCount: 1, additions: 2, deletions: 0 });
    store.appendDiffVersion(task.id, { diffHash: "b".repeat(64), changedFileCount: 2, additions: 3, deletions: 1 });
    const approval = { approvalId: "22222222-2222-4222-8222-222222222222", diffHash: "b".repeat(64), purpose: "create_pr" as const };
    recordApprovalEvent(task, "issued", approval, "pending");
    recordApprovalEvent(task, "accepted", approval, "accepted");
    recordApprovalEvent(task, "invalidated", approval, "validation_failed");
    recordApprovalEvent(task, "failed", approval, "validation_failed");
    const history = getTaskHistory(task.id);
    expect(history.diffVersions.map((version) => version.version)).toEqual([1, 2]);
    expect(history.approvalEvents.map((event) => event.type)).toEqual(["issued", "accepted", "invalidated", "failed"]);
    const raw = new DatabaseSync(store.path);
    expect(() => raw.exec(`UPDATE task_events SET status = 'changed' WHERE task_id = '${task.id}'`)).toThrow("append-only");
    expect(() => raw.exec(`DELETE FROM approval_events WHERE task_id = '${task.id}'`)).toThrow("append-only");
    raw.close();
  });

  it("rolls back event and version appends as one transaction", async () => {
    const { task } = await repositoryTask();
    expect(() => store.transaction(() => {
      store.appendTaskEvent(task.id, { type: "flow_started", actor: "system" });
      store.appendStepVersion(task.id, steps()[0]);
      throw new Error("rollback history");
    })).toThrow("rollback history");
    expect(getTaskHistory(task.id)).toMatchObject({ events: [{ type: "task_created" }, { type: "profile_snapshot_created" }, { type: "template_snapshot_created" }], stepVersions: [] });
  });

  it("rejects forbidden or unknown event metadata", async () => {
    const { task } = await repositoryTask();
    expect(() => store.appendTaskEvent(task.id, { type: "flow_started", actor: "system", metadata: { token: "secret" } as never })).toThrow("forbidden");
    expect(() => store.appendTaskEvent(task.id, { type: "flow_started", actor: "system", metadata: { prompt: "full prompt" } as never })).toThrow("forbidden");
    expect(getTaskHistory(task.id).events).toHaveLength(3);
  });

  it("migrates a real v1 database transactionally without losing tasks", () => {
    const path = join(testRoot, "v1.db");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES (1, '2025-01-01T00:00:00.000Z');
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
      INSERT INTO tasks VALUES (
        '11111111-1111-1111-1111-111111111111', 'repo', 'Repo', '/repo', '/allowed', 'main',
        'multiagents/11111111-1111-1111-1111-111111111111', 'abc', NULL, '/worktree', '/worktrees',
        0, 'missing', 'draft', 'kept prompt', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z',
        NULL, NULL, NULL, NULL, 'unavailable', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, 'orphaned', NULL, '{}'
      );
    `);
    database.close();
    const migrated = new StateStore(path);
    expect(migrated.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(migrated.loadTasks()[0]).toMatchObject({ id: "11111111-1111-1111-1111-111111111111", prompt: "kept prompt", profile: { name: "safe_default", version: 1 } });
    expect(migrated.loadTaskHistory("11111111-1111-1111-1111-111111111111")).toMatchObject({ events: [{ type: "task_created", actor: "system", status: "draft" }, { type: "template_snapshot_created", actor: "system", status: "created" }], stepVersions: [], diffVersions: [], approvalEvents: [] });
    migrated.close();
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
    await expect(resumeTask(task.id, { allowedRoot, worktreeRoot: task.worktreeRoot })).rejects.toThrow("Task branch does not match");
    expect(getTask(task.id)).toMatchObject({ recoveryStatus: "invalid", worktreeStatus: "invalid" });

    const second = await repositoryTask("project2");
    second.task.repoPath = testRoot;
    persistTask(second.task);
    reloadTasksFromStoreForTests();
    await expect(resumeTask(second.task.id, { allowedRoot: second.allowedRoot, worktreeRoot: second.task.worktreeRoot })).rejects.toThrow();
    expect(getTask(second.task.id)).toMatchObject({ recoveryStatus: "invalid" });
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
    expect(getTaskHistory(archived.task.id).events.at(-1)?.type).toBe("task_archived");
  });

  it("requires explicit PR cleanup confirmation, removes only a clean worktree, and preserves audit history", async () => {
    const { task } = await repositoryTask();
    task.prNumber = 9; task.prUrl = "https://github.com/example/project/pull/9"; task.commitSha = task.baseSha;
    persistTask(task);
    await expect(deleteTask(task.id)).rejects.toThrow("Explicit confirmation");
    expect(getTaskHistory(task.id).events.at(-1)?.type).toBe("worktree_cleanup_requested");
    await deleteTask(task.id, { confirmedPrCleanup: true });
    expect(getTask(task.id)).toMatchObject({ status: "archived", worktreeStatus: "removed", prNumber: 9 });
    expect(getTaskHistory(task.id).events.slice(-3).map((event) => event.type)).toEqual(["worktree_cleanup_requested", "worktree_removed", "task_archived"]);
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
    const commit = vi.fn(async (value: RepoTask) => { await runGit(value.worktreePath, ["commit", "-m", "saved"]); });
    const createPr = vi.fn(async () => ({ url: "https://github.com/example/project/pull/42", number: 42 }));
    await approveAndCreatePullRequest(task.id, input, {
      stage: async (value) => { await runGit(value.worktreePath, ["add", "--all"]); }, commit, push: async () => undefined, checkGhAuth: async () => undefined,
      createPr, checkDependencies: async () => undefined, runValidation: async () => undefined,
    });
    expect(commit).toHaveBeenCalledOnce(); expect(createPr).toHaveBeenCalledOnce();
    expect(getTaskHistory(task.id).events.map((event) => event.type)).toEqual(expect.arrayContaining(["approval_accepted", "validation_started", "validation_passed", "commit_created", "branch_pushed", "pr_created"]));
    reloadTasksFromStoreForTests();
    const commitAgain = vi.fn(async () => undefined);
    await expect(approveAndCreatePullRequest(task.id, input, { commit: commitAgain })).rejects.toThrow("not awaiting approval");
    expect(commitAgain).not.toHaveBeenCalled();
    const createAgain = vi.fn(async () => ({ url: "https://github.com/example/project/pull/99", number: 99 }));
    await expect(retryPullRequest(task.id, { createPr: createAgain })).resolves.toMatchObject({ prNumber: 42 });
    expect(createAgain).not.toHaveBeenCalled();
  });
});
