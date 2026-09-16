import { describe, expect, it, vi } from "vitest";
import { createReviewRerunMutationService } from "./review-rerun-mutation-service";

describe("review rerun mutation service", () => {
  it("returns parse errors without starting a stream", async () => {
    const service = createReviewRerunMutationService({
      initialize: vi.fn(async () => undefined),
      parseCommand: vi.fn(() => ({ error: "Invalid rerun stepId" })),
      reconstruct: vi.fn(),
      loadTask: vi.fn(),
      prepareRuntime: vi.fn(),
      beginRerun: vi.fn(),
      requireTemplate: vi.fn(),
      executionPrompt: vi.fn(),
      executionRoot: vi.fn(),
      createStream: vi.fn(),
      diffFingerprint: vi.fn(),
      runtimeExecutor: vi.fn(),
      recordEvent: vi.fn(),
      completeReview: vi.fn(),
      agentSet: {} as never,
    });

    await expect(
      service.prepare({ taskId: "bad", stepId: "codex_draft" }, new AbortController().signal),
    ).resolves.toEqual({
      kind: "error",
      status: 400,
      body: { error: "Invalid rerun stepId" },
    });
  });
});
