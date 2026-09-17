import { describe, expect, it, vi } from "vitest";
import {
  createTaskReassociateMutationService,
  TaskReassociateInputError,
} from "./task-reassociate-mutation-service";

describe("task reassociate mutation service", () => {
  it("requires confirmation and fingerprint", async () => {
    const service = createTaskReassociateMutationService({
      reassociate: vi.fn(),
      toPublicTask: vi.fn(),
    });

    await expect(service.apply("task-1", { confirmed: true })).rejects.toBeInstanceOf(
      TaskReassociateInputError,
    );
  });

  it("returns the public task on success", async () => {
    const reassociate = vi.fn(async () => ({ id: "task-1" })) as never;
    const service = createTaskReassociateMutationService({
      reassociate,
      toPublicTask: vi.fn(() => ({ id: "task-1", public: true })) as never,
    });

    await expect(
      service.apply("task-1", { confirmed: true, fingerprint: "fp-1" }),
    ).resolves.toEqual({ task: { id: "task-1", public: true } });
    expect(reassociate).toHaveBeenCalledWith("task-1", "fp-1");
  });
});
