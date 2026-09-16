import { describe, expect, it, vi } from "vitest";
import { type RepoTask } from "../server/tasks";
import {
  createTaskProfileService,
  TaskProfileInvalidError,
  TaskProfileNotFoundError,
} from "./task-profile-service";

const task = { id: "task-1" } as RepoTask;

type TaskProfileDependencies = NonNullable<Parameters<typeof createTaskProfileService>[0]>;
const profile = {} as ReturnType<TaskProfileDependencies["requireProfile"]>;

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  requireProfile: (value: RepoTask) => typeof profile;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => task),
    requireProfile: vi.fn(() => profile),
    ...overrides,
  };
}

describe("task profile service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createTaskProfileService(
      deps as unknown as Parameters<typeof createTaskProfileService>[0],
    );

    await expect(service.load("missing")).rejects.toBeInstanceOf(TaskProfileNotFoundError);
    expect(calls).toEqual(["recovery", "get"]);
    expect(deps.requireProfile).not.toHaveBeenCalled();
  });

  it("returns the task profile for an existing task", async () => {
    const deps = dependencies();
    const service = createTaskProfileService(
      deps as unknown as Parameters<typeof createTaskProfileService>[0],
    );

    await expect(service.load(task.id)).resolves.toEqual({ profile });
    expect(deps.get).toHaveBeenCalledWith(task.id);
    expect(deps.requireProfile).toHaveBeenCalledWith(task);
  });

  it("maps profile validation failures to TaskProfileInvalidError", async () => {
    const deps = dependencies({
      requireProfile: vi.fn(() => {
        throw new Error("profile mismatch");
      }),
    });
    const service = createTaskProfileService(
      deps as unknown as Parameters<typeof createTaskProfileService>[0],
    );

    await expect(service.load(task.id)).rejects.toMatchObject({
      name: "TaskProfileInvalidError",
      message: "profile mismatch",
    });
    await expect(service.load(task.id)).rejects.toBeInstanceOf(TaskProfileInvalidError);
  });
});
