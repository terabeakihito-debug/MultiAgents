import { describe, expect, it, vi } from "vitest";
import { createRetentionPolicyService } from "./retention-policy-service";

describe("retention policy service", () => {
  it("returns the stored retention preset", () => {
    const loadPreset = vi.fn(() => "conservative" as const);
    const service = createRetentionPolicyService(
      { loadPreset } as unknown as Parameters<typeof createRetentionPolicyService>[0],
    );

    expect(service.load()).toEqual({ preset: "conservative" });
    expect(loadPreset).toHaveBeenCalledTimes(1);
  });
});
