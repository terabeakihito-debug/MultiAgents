import { describe, expect, it, vi } from "vitest";
import {
  createTaskFindingsExtractMutationService,
  TaskFindingsExtractInputError,
} from "./task-findings-extract-mutation-service";

describe("task findings extract mutation service", () => {
  it("requires explicit confirmation", async () => {
    const service = createTaskFindingsExtractMutationService({
      initialize: vi.fn(async () => undefined),
      extract: vi.fn(),
      loadRemediation: vi.fn(),
      loadFindingEvents: vi.fn(() => []),
    });

    await expect(service.apply("task-1", {})).rejects.toBeInstanceOf(
      TaskFindingsExtractInputError,
    );
  });

  it("returns enriched findings on success", async () => {
    const extract = vi.fn(async () => [
      { findingId: "f-1", title: "Issue" },
    ]) as never;
    const service = createTaskFindingsExtractMutationService({
      initialize: vi.fn(async () => undefined),
      extract,
      loadRemediation: vi.fn(() => ({ status: "open" })) as never,
      loadFindingEvents: vi.fn(() => [{ type: "created" }]) as never,
    });

    await expect(service.apply("task-1", { confirmed: true })).resolves.toEqual({
      findings: [
        {
          findingId: "f-1",
          title: "Issue",
          remediation: { status: "open" },
          history: [{ type: "created" }],
        },
      ],
    });
  });
});
