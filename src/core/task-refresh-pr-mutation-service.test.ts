import { describe, expect, it, vi } from "vitest";
import { createTaskRefreshPrMutationService } from "./task-refresh-pr-mutation-service";

describe("task refresh-pr mutation service", () => {
  it("returns the task on success", async () => {
    const refresh = vi.fn(async () => ({ id: "task-1", prNumber: 42 })) as never;
    const service = createTaskRefreshPrMutationService({
      initialize: vi.fn(async () => undefined),
      refresh,
    });

    await expect(service.apply("task-1")).resolves.toEqual({
      task: { id: "task-1", prNumber: 42 },
    });
  });
});
