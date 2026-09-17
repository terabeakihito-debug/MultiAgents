import { describe, expect, it, vi } from "vitest";
import {
  createFindingDismissMutationService,
  FindingDismissInputError,
} from "./finding-dismiss-mutation-service";

describe("finding dismiss mutation service", () => {
  it("requires explicit confirmation", async () => {
    const service = createFindingDismissMutationService({
      initialize: vi.fn(async () => undefined),
      dismiss: vi.fn(),
      loadRemediation: vi.fn(),
      loadFindingEvents: vi.fn(() => []),
    });

    await expect(service.apply("f-1", {})).rejects.toBeInstanceOf(
      FindingDismissInputError,
    );
  });

  it("returns finding with remediation and history on success", async () => {
    const dismiss = vi.fn(() => ({
      findingId: "f-1",
      status: "dismissed",
    })) as never;
    const service = createFindingDismissMutationService({
      initialize: vi.fn(async () => undefined),
      dismiss,
      loadRemediation: vi.fn(() => ({ status: "open" })) as never,
      loadFindingEvents: vi.fn(() => [{ type: "finding_dismissed" }]) as never,
    });

    await expect(
      service.apply("f-1", { confirmed: true, reason: "noise" }),
    ).resolves.toEqual({
      finding: { findingId: "f-1", status: "dismissed" },
      remediation: { status: "open" },
      history: [{ type: "finding_dismissed" }],
    });
    expect(dismiss).toHaveBeenCalledWith("f-1", "noise");
  });
});
