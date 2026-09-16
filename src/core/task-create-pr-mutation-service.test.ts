import { describe, expect, it, vi } from "vitest";
import { createTaskCreatePrMutationService } from "./task-create-pr-mutation-service";

describe("task create-pr mutation service", () => {
  it("returns the task on success", async () => {
    const retryPullRequest = vi.fn(async () => ({ id: "task-1", prNumber: 42 })) as never;
    const service = createTaskCreatePrMutationService({
      initialize: vi.fn(async () => undefined),
      retryPullRequest,
    });

    await expect(service.apply("task-1")).resolves.toEqual({
      task: { id: "task-1", prNumber: 42 },
    });
  });
});
