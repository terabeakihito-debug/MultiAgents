import { describe, expect, it, vi } from "vitest";
import {
  createFindingPriorityMutationService,
  FindingPriorityInputError,
} from "./finding-priority-mutation-service";

describe("finding priority mutation service", () => {
  it("requires confirmation and valid priority", async () => {
    const service = createFindingPriorityMutationService({
      initialize: vi.fn(async () => undefined),
      changePriority: vi.fn(),
      loadRemediation: vi.fn(),
      loadFindingEvents: vi.fn(() => []),
    });

    await expect(
      service.apply("f-1", { confirmed: true, priority: "invalid" }),
    ).rejects.toBeInstanceOf(FindingPriorityInputError);
  });

  it("returns finding with remediation and history on success", async () => {
    const changePriority = vi.fn(() => ({
      findingId: "f-1",
      humanPriority: "urgent",
    })) as never;
    const service = createFindingPriorityMutationService({
      initialize: vi.fn(async () => undefined),
      changePriority,
      loadRemediation: vi.fn(() => ({ findingId: "f-1" })) as never,
      loadFindingEvents: vi.fn(() => [{ type: "finding_priority_changed" }]) as never,
    });

    await expect(
      service.apply("f-1", { confirmed: true, priority: "urgent" }),
    ).resolves.toEqual({
      finding: { findingId: "f-1", humanPriority: "urgent" },
      remediation: { findingId: "f-1" },
      history: [{ type: "finding_priority_changed" }],
    });
    expect(changePriority).toHaveBeenCalledWith("f-1", "urgent");
  });
});
