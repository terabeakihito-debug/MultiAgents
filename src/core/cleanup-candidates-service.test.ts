import { describe, expect, it, vi } from "vitest";
import { createCleanupCandidatesService } from "./cleanup-candidates-service";

describe("cleanup candidates service", () => {
  it("evaluates cleanup candidates", async () => {
    const payload = {
      candidates: [{ id: "candidate-1" }],
      potentialSavingsBytes: 1024,
      blocked: 0,
      preset: "conservative",
    };
    const evaluate = vi.fn(async () => payload);
    const service = createCleanupCandidatesService(
      { evaluate } as unknown as Parameters<typeof createCleanupCandidatesService>[0],
    );

    await expect(service.load()).resolves.toEqual(payload);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
