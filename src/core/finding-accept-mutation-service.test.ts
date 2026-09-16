import { describe, expect, it, vi } from "vitest";
import {
  createFindingAcceptMutationService,
  FindingAcceptInputError,
} from "./finding-accept-mutation-service";

describe("finding accept mutation service", () => {
  it("requires explicit confirmation", async () => {
    const service = createFindingAcceptMutationService({
      initialize: vi.fn(async () => undefined),
      accept: vi.fn(),
      loadRemediation: vi.fn(),
      loadFindingEvents: vi.fn(() => []),
    });

    await expect(service.apply("f-1", {})).rejects.toBeInstanceOf(
      FindingAcceptInputError,
    );
  });

  it("returns finding with remediation and history on success", async () => {
    const accept = vi.fn(() => ({
      findingId: "f-1",
      status: "accepted",
    })) as never;
    const service = createFindingAcceptMutationService({
      initialize: vi.fn(async () => undefined),
      accept,
      loadRemediation: vi.fn(() => ({ status: "open" })) as never,
      loadFindingEvents: vi.fn(() => [{ type: "finding_accepted" }]) as never,
    });

    await expect(service.apply("f-1", { confirmed: true })).resolves.toEqual({
      finding: { findingId: "f-1", status: "accepted" },
      remediation: { status: "open" },
      history: [{ type: "finding_accepted" }],
    });
  });
});
