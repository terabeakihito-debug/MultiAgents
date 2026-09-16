import { describe, expect, it, vi } from "vitest";
import {
  createTaskApproveMutationService,
  TaskApproveInputError,
} from "./task-approve-mutation-service";

describe("task approve mutation service", () => {
  it("requires approval fields", async () => {
    const service = createTaskApproveMutationService({
      initialize: vi.fn(async () => undefined),
      approve: vi.fn(),
    });

    await expect(service.apply("task-1", { approved: true })).rejects.toBeInstanceOf(
      TaskApproveInputError,
    );
  });

  it("returns the task on success", async () => {
    const approve = vi.fn(async () => ({ id: "task-1", status: "open" })) as never;
    const service = createTaskApproveMutationService({
      initialize: vi.fn(async () => undefined),
      approve,
    });

    await expect(
      service.apply("task-1", {
        approved: true,
        diffHash: "hash",
        approvalId: "approval-1",
      }),
    ).resolves.toEqual({ task: { id: "task-1", status: "open" } });
  });
});
