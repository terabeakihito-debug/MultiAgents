import { describe, expect, it, vi } from "vitest";
import {
  createTaskApproveReworkMutationService,
  TaskApproveReworkInputError,
} from "./task-approve-rework-mutation-service";

describe("task approve-rework mutation service", () => {
  it("requires approval fields", async () => {
    const service = createTaskApproveReworkMutationService({
      initialize: vi.fn(async () => undefined),
      approveRework: vi.fn(),
    });

    await expect(service.apply("task-1", {})).rejects.toBeInstanceOf(
      TaskApproveReworkInputError,
    );
  });

  it("returns the task on success", async () => {
    const approveRework = vi.fn(async () => ({ id: "task-1" })) as never;
    const service = createTaskApproveReworkMutationService({
      initialize: vi.fn(async () => undefined),
      approveRework,
    });

    await expect(
      service.apply("task-1", {
        approved: true,
        diffHash: "hash",
        approvalId: "ap-1",
      }),
    ).resolves.toEqual({ task: { id: "task-1" } });
  });
});
