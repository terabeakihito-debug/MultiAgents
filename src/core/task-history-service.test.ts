import { describe, expect, it, vi } from "vitest";
import { type RepoTask } from "../server/tasks";
import { createTaskHistoryService, TaskHistoryNotFoundError } from "./task-history-service";

const task = { id: "task-1" } as RepoTask;
type TaskHistoryDependencies = NonNullable<Parameters<typeof createTaskHistoryService>[0]>;
const history: ReturnType<TaskHistoryDependencies["getHistory"]> = {
  events: [],
  stepVersions: [],
  diffVersions: [],
  approvalEvents: [],
};

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  getHistory: (id: string) => typeof history;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => task),
    getHistory: vi.fn(() => history),
    ...overrides,
  };
}

describe("task history service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createTaskHistoryService(deps as unknown as Parameters<typeof createTaskHistoryService>[0]);

    await expect(service.load("missing")).rejects.toBeInstanceOf(TaskHistoryNotFoundError);
    expect(calls).toEqual(["recovery", "get"]);
    expect(deps.getHistory).not.toHaveBeenCalled();
  });

  it("loads history for an existing task", async () => {
    const deps = dependencies();
    const service = createTaskHistoryService(deps as unknown as Parameters<typeof createTaskHistoryService>[0]);

    await expect(service.load(task.id)).resolves.toEqual({ history });
    expect(deps.get).toHaveBeenCalledWith(task.id);
    expect(deps.getHistory).toHaveBeenCalledWith(task.id);
  });
});
