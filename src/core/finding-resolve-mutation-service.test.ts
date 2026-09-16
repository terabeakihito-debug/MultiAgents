import { describe, expect, it, vi } from "vitest";
import {
  createFindingResolveMutationService,
  FindingResolveInputError,
} from "./finding-resolve-mutation-service";

describe("finding resolve mutation service", () => {
  it("requires explicit confirmation", async () => {
    const service = createFindingResolveMutationService({
      initialize: vi.fn(async () => undefined),
      resolve: vi.fn(),
      loadRemediation: vi.fn(),
      loadFindingEvents: vi.fn(() => []),
    });

    await expect(service.apply("f-1", {})).rejects.toBeInstanceOf(
      FindingResolveInputError,
    );
  });

  it("returns finding with remediation and history on success", async () => {
    const resolve = vi.fn(() => ({
      findingId: "f-1",
      resolvedAt: "now",
    })) as never;
    const service = createFindingResolveMutationService({
      initialize: vi.fn(async () => undefined),
      resolve,
      loadRemediation: vi.fn(() => ({ findingId: "f-1" })) as never,
      loadFindingEvents: vi.fn(() => [{ type: "finding_resolved" }]) as never,
    });

    await expect(service.apply("f-1", { confirmed: true })).resolves.toEqual({
      finding: { findingId: "f-1", resolvedAt: "now" },
      remediation: { findingId: "f-1" },
      history: [{ type: "finding_resolved" }],
    });
  });
});
