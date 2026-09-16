import { describe, expect, it, vi } from "vitest";
import { createTaskReassociatePreviewMutationService } from "./task-reassociate-preview-mutation-service";

describe("task reassociate preview mutation service", () => {
  it("returns the preview payload", async () => {
    const preview = { fingerprint: "fp-1", candidates: [] };
    const service = createTaskReassociatePreviewMutationService({
      preview: vi.fn(async () => preview) as never,
    });

    await expect(service.apply("task-1")).resolves.toEqual({ preview });
  });
});
