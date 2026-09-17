import { describe, expect, it, vi } from "vitest";
import { createCleanupPreviewMutationService } from "./cleanup-preview-mutation-service";

describe("cleanup preview mutation service", () => {
  it("defaults missing candidateIds to an empty selection", async () => {
    const preview = vi.fn(async () => ({ selected: [], estimatedBytes: 0 })) as never;
    const service = createCleanupPreviewMutationService({ preview });

    await service.apply({});
    expect(preview).toHaveBeenCalledWith([]);
  });

  it("forwards candidateIds when provided", async () => {
    const preview = vi.fn(async () => ({ selected: [], estimatedBytes: 0 })) as never;
    const service = createCleanupPreviewMutationService({ preview });

    await service.apply({ candidateIds: ["notification:n-1"] });
    expect(preview).toHaveBeenCalledWith(["notification:n-1"]);
  });
});
