import { describe, expect, it, vi } from "vitest";
import {
  createRetentionPolicyMutationService,
  RetentionPresetInvalidError,
} from "./retention-policy-mutation-service";

describe("retention policy mutation service", () => {
  it("rejects invalid presets", () => {
    const service = createRetentionPolicyMutationService({
      save: vi.fn(),
    });

    expect(() => service.apply({ preset: "custom" })).toThrow(
      RetentionPresetInvalidError,
    );
    expect(() => service.apply(null)).toThrow(RetentionPresetInvalidError);
  });

  it("saves a valid preset", () => {
    const save = vi.fn(() => "balanced" as const);
    const service = createRetentionPolicyMutationService({ save });

    expect(service.apply({ preset: "balanced" })).toEqual({
      preset: "balanced",
    });
    expect(save).toHaveBeenCalledWith("balanced");
  });
});
