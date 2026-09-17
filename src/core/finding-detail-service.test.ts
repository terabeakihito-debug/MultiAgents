import { describe, expect, it, vi } from "vitest";
import {
  createFindingDetailService,
  FindingDetailNotFoundError,
} from "./finding-detail-service";

describe("finding detail service", () => {
  it("returns finding detail payload", () => {
    const service = createFindingDetailService({
      loadFinding: vi.fn(() => ({ findingId: "f-1" })) as never,
      loadRemediation: vi.fn(() => ({ findingId: "f-1", status: "open" })) as never,
      loadHistory: vi.fn(() => [{ event: "created" }]) as never,
    });

    expect(service.load("f-1")).toEqual({
      finding: { findingId: "f-1" },
      remediation: { findingId: "f-1", status: "open" },
      history: [{ event: "created" }],
    });
  });

  it("rejects missing findings", () => {
    const service = createFindingDetailService({
      loadFinding: vi.fn(() => undefined) as never,
      loadRemediation: vi.fn(),
      loadHistory: vi.fn(),
    });

    expect(() => service.load("missing")).toThrow(FindingDetailNotFoundError);
  });
});
