import { describe, expect, it, vi } from "vitest";
import { publicTask as projectTask, type RepoTask } from "../server/tasks";
import { createTaskCiService, TaskCiNotFoundError } from "./task-ci-service";

const projectedTask = { id: "task-1" } as ReturnType<typeof projectTask>;
const checks = [{ name: "ci", state: "SUCCESS", bucket: "pass" as const, required: true }];

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  toPublic: (value: RepoTask) => ReturnType<typeof projectTask>;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => ({
      id: "task-1",
      ciMessage: "All checks passed",
      prReview: { checks },
    } as unknown as RepoTask)),
    toPublic: vi.fn(() => projectedTask),
    ...overrides,
  };
}

describe("task CI service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createTaskCiService(
      deps as unknown as Parameters<typeof createTaskCiService>[0],
    );

    await expect(service.load("missing")).rejects.toBeInstanceOf(TaskCiNotFoundError);
    expect(calls).toEqual(["recovery", "get"]);
    expect(deps.toPublic).not.toHaveBeenCalled();
  });

  it("projects the public task, CI checks, and message", async () => {
    const deps = dependencies();
    const service = createTaskCiService(
      deps as unknown as Parameters<typeof createTaskCiService>[0],
    );

    await expect(service.load("task-1")).resolves.toEqual({
      task: projectedTask,
      checks,
      message: "All checks passed",
    });
    expect(deps.get).toHaveBeenCalledWith("task-1");
  });

  it("returns an empty check list when the task has no pull-request review", async () => {
    const deps = dependencies({
      get: vi.fn(() => ({ id: "task-1" } as RepoTask)),
    });
    const service = createTaskCiService(
      deps as unknown as Parameters<typeof createTaskCiService>[0],
    );

    await expect(service.load("task-1")).resolves.toEqual({
      task: projectedTask,
      checks: [],
      message: undefined,
    });
  });
});
