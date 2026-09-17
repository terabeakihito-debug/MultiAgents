import { describe, expect, it, vi } from "vitest";
import { createReviewFlowStreamMutationService } from "./review-flow-stream-mutation-service";

describe("review flow stream mutation service", () => {
  it("requires a prompt before opening a stream", async () => {
    const service = createReviewFlowStreamMutationService({
      initialize: vi.fn(async () => undefined),
      loadTask: vi.fn(),
      prepareRuntime: vi.fn(),
      beginReview: vi.fn(),
      requireTemplate: vi.fn(),
      executionPrompt: vi.fn(),
      executionRoot: vi.fn(),
      createStream: vi.fn(),
      diffFingerprint: vi.fn(),
      loadDiff: vi.fn(),
      runtimeExecutor: vi.fn(),
      recordEvent: vi.fn(),
      completeReview: vi.fn(),
      agentSet: {} as never,
    });

    await expect(
      service.prepare({}, new AbortController().signal),
    ).resolves.toEqual({
      kind: "error",
      status: 400,
      body: { error: "Prompt is required" },
    });
  });
});
