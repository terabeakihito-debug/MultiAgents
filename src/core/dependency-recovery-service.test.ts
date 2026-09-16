import { describe, expect, it, vi } from "vitest";
import { type RepoTask } from "../server/tasks";
import {
  createDependencyRecoveryService,
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
} from "./dependency-recovery-service";

const task = {
  id: "task-1",
  worktreePath: "/managed/worktree",
} as RepoTask;

const instructions = {
  command: "cd -- '/managed/worktree' && npm install",
};

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  buildInstructions: (value: RepoTask) => typeof instructions | undefined;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => task),
    buildInstructions: vi.fn(() => instructions),
    ...overrides,
  };
}

describe("dependency recovery service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createDependencyRecoveryService(
      deps as unknown as Parameters<typeof createDependencyRecoveryService>[0],
    );

    await expect(service.load("missing")).rejects.toBeInstanceOf(
      DependencyRecoveryTaskNotFoundError,
    );
    expect(calls).toEqual(["recovery", "get"]);
    expect(deps.buildInstructions).not.toHaveBeenCalled();
  });

  it("returns dependency recovery instructions for a recoverable task", async () => {
    const deps = dependencies();
    const service = createDependencyRecoveryService(
      deps as unknown as Parameters<typeof createDependencyRecoveryService>[0],
    );

    await expect(service.load(task.id)).resolves.toEqual(instructions);
    expect(deps.get).toHaveBeenCalledWith(task.id);
    expect(deps.buildInstructions).toHaveBeenCalledWith(task);
  });

  it("reports unavailable instructions without exposing a command", async () => {
    const deps = dependencies({
      buildInstructions: vi.fn(() => undefined),
    });
    const service = createDependencyRecoveryService(
      deps as unknown as Parameters<typeof createDependencyRecoveryService>[0],
    );

    await expect(service.load(task.id)).rejects.toBeInstanceOf(
      DependencyRecoveryUnavailableError,
    );
  });
});
