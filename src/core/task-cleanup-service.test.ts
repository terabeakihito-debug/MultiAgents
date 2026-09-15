import { describe, expect, it, vi } from "vitest";
import { createTaskCleanupService, parseTaskCleanupRequest, TaskCleanupRequestError } from "./task-cleanup-service";

describe("task cleanup service", () => {
  it("validates cleanup requests without depending on HTTP", () => {
    expect(parseTaskCleanupRequest({})).toEqual({});
    expect(parseTaskCleanupRequest({ confirmedPrCleanup: true })).toEqual({ confirmedPrCleanup: true });
    expect(parseTaskCleanupRequest({ confirmedPrCleanup: false })).toEqual({ confirmedPrCleanup: false });
    expect(() => parseTaskCleanupRequest({ forbidden: true })).toThrowError(TaskCleanupRequestError);
    expect(() => parseTaskCleanupRequest({ confirmedPrCleanup: "yes" })).toThrow("Invalid cleanup request");
  });

  it("delegates task deletion through the core service boundary", async () => {
    const remove = vi.fn(async () => undefined);
    const service = createTaskCleanupService({ remove } as Parameters<typeof createTaskCleanupService>[0]);

    await service.remove("task-1", { confirmedPrCleanup: true });

    expect(remove).toHaveBeenCalledWith("task-1", { confirmedPrCleanup: true });
  });
});
