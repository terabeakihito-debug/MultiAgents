import { describe, expect, it, vi } from "vitest";
import { publicTask as projectTask, type RepoTask } from "../server/tasks";
import {
  createTaskPrService,
  TaskPrConflictError,
  TaskPrNotFoundError,
} from "./task-pr-service";

const projectedTask = { id: "task-1" } as ReturnType<typeof projectTask>;
const pullRequest = { title: "Fix bug", checks: [] };
const intake = { status: "pending" };

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  toPublic: (value: RepoTask) => ReturnType<typeof projectTask>;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => ({
      id: "task-1",
      prNumber: 42,
      prReview: pullRequest,
      reviewIntake: intake,
    } as unknown as RepoTask)),
    toPublic: vi.fn(() => projectedTask),
    ...overrides,
  };
}

describe("task PR service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createTaskPrService(
      deps as unknown as Parameters<typeof createTaskPrService>[0],
    );

    await expect(service.load("missing")).rejects.toBeInstanceOf(TaskPrNotFoundError);
    expect(calls).toEqual(["recovery", "get"]);
    expect(deps.toPublic).not.toHaveBeenCalled();
  });

  it("rejects tasks without an existing pull request", async () => {
    const deps = dependencies({
      get: vi.fn(() => ({ id: "task-1" } as RepoTask)),
    });
    const service = createTaskPrService(
      deps as unknown as Parameters<typeof createTaskPrService>[0],
    );

    await expect(service.load("task-1")).rejects.toBeInstanceOf(TaskPrConflictError);
    expect(deps.toPublic).not.toHaveBeenCalled();
  });

  it("projects the public task, pull request review, and intake", async () => {
    const deps = dependencies();
    const service = createTaskPrService(
      deps as unknown as Parameters<typeof createTaskPrService>[0],
    );

    await expect(service.load("task-1")).resolves.toEqual({
      task: projectedTask,
      pullRequest,
      intake,
    });
    expect(deps.get).toHaveBeenCalledWith("task-1");
  });
});
