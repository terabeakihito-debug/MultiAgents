import { describe, expect, it, vi } from "vitest";
import {
  createFindingConvertMutationService,
  FindingConvertInputError,
} from "./finding-convert-mutation-service";

describe("finding convert mutation service", () => {
  it("requires conversion fields", async () => {
    const service = createFindingConvertMutationService({
      initialize: vi.fn(async () => undefined),
      convert: vi.fn(),
      publicTask: vi.fn(),
      loadRemediation: vi.fn(),
      loadFindingEvents: vi.fn(() => []),
    });

    await expect(service.apply("f-1", { confirmed: true })).rejects.toBeInstanceOf(
      FindingConvertInputError,
    );
  });

  it("returns finding, task, remediation, and history on success", async () => {
    const convert = vi.fn(async () => ({
      finding: { findingId: "f-1", status: "converted" },
      task: { id: "task-2", repoId: "repo-1" },
    })) as never;
    const service = createFindingConvertMutationService({
      initialize: vi.fn(async () => undefined),
      convert,
      publicTask: vi.fn((task) => ({ ...task, public: true })) as never,
      loadRemediation: vi.fn(() => ({ findingId: "f-1" })) as never,
      loadFindingEvents: vi.fn(() => [{ type: "implementation_task_created" }]) as never,
    });

    await expect(
      service.apply("f-1", {
        confirmed: true,
        templateId: "bug_fix",
        objective: "Fix the bug",
      }),
    ).resolves.toEqual({
      finding: { findingId: "f-1", status: "converted" },
      task: { id: "task-2", repoId: "repo-1", public: true },
      remediation: { findingId: "f-1" },
      history: [{ type: "implementation_task_created" }],
    });
  });
});
