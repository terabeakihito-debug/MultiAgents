import { describe, expect, it, vi } from "vitest";
import {
  createTaskDependencyRecoveryInstructionsMutationService,
  DependencyRecoveryTaskNotFoundError,
} from "./task-dependency-recovery-instructions-mutation-service";

describe("task dependency recovery instructions mutation service", () => {
  it("returns instructions from the recovery service", async () => {
    const instructions = { steps: ["run npm install"] };
    const service = createTaskDependencyRecoveryInstructionsMutationService({
      load: vi.fn(async () => instructions) as never,
    });

    await expect(service.apply("task-1")).resolves.toBe(instructions);
  });

  it("propagates not found errors", async () => {
    const service = createTaskDependencyRecoveryInstructionsMutationService({
      load: vi.fn(async () => {
        throw new DependencyRecoveryTaskNotFoundError();
      }),
    });

    await expect(service.apply("task-1")).rejects.toBeInstanceOf(
      DependencyRecoveryTaskNotFoundError,
    );
  });
});
