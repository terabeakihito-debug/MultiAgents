import { describe, expect, it, vi } from "vitest";
import { createTaskFetchReviewMutationService } from "./task-fetch-review-mutation-service";

describe("task fetch-review mutation service", () => {
  it("returns the task on success", async () => {
    const fetchReview = vi.fn(async () => ({ id: "task-1", status: "reviewed" })) as never;
    const service = createTaskFetchReviewMutationService({
      initialize: vi.fn(async () => undefined),
      fetchReview,
    });

    await expect(service.apply("task-1")).resolves.toEqual({
      task: { id: "task-1", status: "reviewed" },
    });
  });
});
