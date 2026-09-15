import { describe, expect, it, vi } from "vitest";
import { publicTask as projectTask, type RepoTask, type TaskDiff } from "../server/tasks";
import { createTaskDetailService, TaskDetailNotFoundError } from "./task-detail-service";

const task = { id: "task-1", worktreeAvailable: true } as unknown as RepoTask;
const projectedTask = {} as ReturnType<typeof projectTask>;
const diff: TaskDiff = {
  trackedFiles: ["README.md"],
  untrackedFiles: [],
  stat: " README.md | 1 +",
  patch: "diff --git a/README.md b/README.md",
  untrackedPatch: "",
  truncated: false,
  approvable: true,
};

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  getDiff: (value: RepoTask) => Promise<TaskDiff>;
  toPublic: (value: RepoTask) => ReturnType<typeof projectTask>;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => task),
    getDiff: vi.fn(async () => diff),
    toPublic: vi.fn(() => projectedTask),
    ...overrides,
  };
}

describe("task detail service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createTaskDetailService(deps as unknown as Parameters<typeof createTaskDetailService>[0]);

    await expect(service.load("missing")).rejects.toBeInstanceOf(TaskDetailNotFoundError);
    expect(calls).toEqual(["recovery", "get"]);
  });

  it("returns the established review-only fallback when the worktree is unavailable", async () => {
    const unavailable = { ...task, worktreeAvailable: false } as RepoTask;
    const deps = dependencies({ get: vi.fn(() => unavailable) });
    const service = createTaskDetailService(deps as unknown as Parameters<typeof createTaskDetailService>[0]);

    const result = await service.load(unavailable.id);

    expect(result).toMatchObject({ conflict: false, task: projectedTask });
    expect(result.diff).toMatchObject({ approvable: false, trackedFiles: [], untrackedFiles: [] });
    expect(result.diff.blockedReason).toContain("Managed task worktree is unavailable");
    expect(deps.getDiff).not.toHaveBeenCalled();
  });

  it("loads and projects a normal task diff", async () => {
    const deps = dependencies();
    const service = createTaskDetailService(deps as unknown as Parameters<typeof createTaskDetailService>[0]);

    await expect(service.load(task.id)).resolves.toEqual({ task: projectedTask, diff, conflict: false });
    expect(deps.getDiff).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing second diff read for conflict payloads", async () => {
    const getDiff = vi.fn()
      .mockRejectedValueOnce(new Error("first diff failed"))
      .mockResolvedValueOnce(diff);
    const deps = dependencies({ getDiff });
    const service = createTaskDetailService(deps as unknown as Parameters<typeof createTaskDetailService>[0]);

    await expect(service.load(task.id)).resolves.toEqual({
      task: projectedTask,
      diff,
      error: "first diff failed",
      conflict: true,
    });
    expect(getDiff).toHaveBeenCalledTimes(2);
  });
});
