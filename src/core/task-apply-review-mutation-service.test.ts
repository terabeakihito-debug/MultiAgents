import { describe, expect, it, vi } from "vitest";
import {
  createTaskApplyReviewMutationService,
  TaskApplyReviewInputError,
} from "./task-apply-review-mutation-service";

describe("task apply-review mutation service", () => {
  it("requires explicit approval", async () => {
    const service = createTaskApplyReviewMutationService({
      initialize: vi.fn(async () => undefined),
      applyReview: vi.fn(),
    });

    await expect(service.apply("task-1", {})).rejects.toBeInstanceOf(
      TaskApplyReviewInputError,
    );
  });

  it("returns the task on success", async () => {
    const applyReview = vi.fn(async () => ({ id: "task-1" })) as never;
    const service = createTaskApplyReviewMutationService({
      initialize: vi.fn(async () => undefined),
      applyReview,
    });

    await expect(
      service.apply("task-1", { approved: true }),
    ).resolves.toEqual({ task: { id: "task-1" } });
  });
});
