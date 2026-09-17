import { describe, expect, it, vi } from "vitest";
import {
  createTaskDeleteMutationService,
  TaskCleanupRequestError,
} from "./task-delete-mutation-service";

describe("task delete mutation service", () => {
  it("parses an empty DELETE body", () => {
    const service = createTaskDeleteMutationService({
      initialize: vi.fn(async () => undefined),
      parse: vi.fn(() => ({})),
      remove: vi.fn(async () => undefined),
    });

    expect(service.parseDeleteBody("")).toEqual({});
  });

  it("rejects invalid JSON and cleanup payloads", () => {
    const service = createTaskDeleteMutationService({
      initialize: vi.fn(async () => undefined),
      parse: vi.fn(() => {
        throw new TaskCleanupRequestError();
      }),
      remove: vi.fn(),
    });

    expect(() => service.parseDeleteBody("{")).toThrow(TaskCleanupRequestError);
    expect(() => service.parseDeleteBody('{"forbidden":true}')).toThrow(
      TaskCleanupRequestError,
    );
  });

  it("removes a task through the cleanup boundary", async () => {
    const remove = vi.fn(async () => undefined);
    const service = createTaskDeleteMutationService({
      initialize: vi.fn(async () => undefined),
      parse: vi.fn(() => ({ confirmedPrCleanup: true })),
      remove,
    });

    await service.removeTask("task-1", { confirmedPrCleanup: true });
    expect(remove).toHaveBeenCalledWith("task-1", { confirmedPrCleanup: true });
  });
});
