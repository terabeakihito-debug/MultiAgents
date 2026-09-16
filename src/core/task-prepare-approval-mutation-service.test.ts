import { describe, expect, it, vi } from "vitest";
import { createTaskPrepareApprovalMutationService } from "./task-prepare-approval-mutation-service";

describe("task prepare-approval mutation service", () => {
  it("returns not found when the task is missing", async () => {
    const service = createTaskPrepareApprovalMutationService({
      initialize: vi.fn(async () => undefined),
      loadTask: vi.fn(() => undefined),
      prepare: vi.fn(),
      loadDiff: vi.fn(),
      toPublicTask: vi.fn(),
    });

    await expect(service.apply("task-1")).resolves.toEqual({
      status: 404,
      body: { error: "Task not found" },
    });
  });

  it("returns prepare approval payload on success", async () => {
    const task = { id: "task-1", worktreeAvailable: true } as never;
    const body = { diff: {}, approval: { approvalId: "ap-1" }, task: { id: "task-1" } };
    const service = createTaskPrepareApprovalMutationService({
      initialize: vi.fn(async () => undefined),
      loadTask: vi.fn(() => task),
      prepare: vi.fn(async () => body) as never,
      loadDiff: vi.fn(),
      toPublicTask: vi.fn(),
    });

    await expect(service.apply("task-1")).resolves.toEqual({ status: 200, body });
  });
});
