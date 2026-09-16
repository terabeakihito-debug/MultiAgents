import { describe, expect, it, vi } from "vitest";
import { createCleanupExecuteMutationService } from "./cleanup-execute-mutation-service";

describe("cleanup execute mutation service", () => {
  it("defaults missing candidateIds to an empty selection", async () => {
    const execute = vi.fn(async () => ({
      completed: [],
      estimatedBytes: 0,
      idempotent: true,
    })) as never;
    const service = createCleanupExecuteMutationService({ execute });

    await service.apply({});
    expect(execute).toHaveBeenCalledWith([]);
  });

  it("forwards candidateIds when provided", async () => {
    const execute = vi.fn(async () => ({
      completed: ["notification:n-1"],
      estimatedBytes: 10,
    })) as never;
    const service = createCleanupExecuteMutationService({ execute });

    await service.apply({ candidateIds: ["notification:n-1"] });
    expect(execute).toHaveBeenCalledWith(["notification:n-1"]);
  });
});
