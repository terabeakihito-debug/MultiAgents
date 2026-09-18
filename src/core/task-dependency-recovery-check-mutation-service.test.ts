import { describe, expect, it, vi } from "vitest";
import { DependencyReadinessError } from "../server/pull-request";
import {
  createTaskDependencyRecoveryCheckMutationService,
  DependencyRecoveryTaskNotFoundError,
} from "./task-dependency-recovery-check-mutation-service";

const task = {
  worktreeAvailable: true,
  worktreeStatus: "available",
} as never;

describe("task dependency recovery check mutation service", () => {
  it("reports ready when the task worktree passes the dependency check", async () => {
    const service = createTaskDependencyRecoveryCheckMutationService({
      initializeRecovery: vi.fn(async () => undefined),
      get: vi.fn(() => task),
      checkDependencies: vi.fn(async () => undefined),
    });

    await expect(service.apply("task-1")).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("reports missing when the dependency tree is not ready", async () => {
    const service = createTaskDependencyRecoveryCheckMutationService({
      initializeRecovery: vi.fn(async () => undefined),
      get: vi.fn(() => task),
      checkDependencies: vi.fn(async () => {
        throw new DependencyReadinessError();
      }),
    });

    await expect(service.apply("task-1")).resolves.toMatchObject({
      status: "missing",
    });
  });

  it("propagates not found errors", async () => {
    const service = createTaskDependencyRecoveryCheckMutationService({
      initializeRecovery: vi.fn(async () => undefined),
      get: vi.fn(() => undefined),
      checkDependencies: vi.fn(),
    });

    await expect(service.apply("missing")).rejects.toBeInstanceOf(
      DependencyRecoveryTaskNotFoundError,
    );
  });
});
