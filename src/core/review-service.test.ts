import { describe, expect, it, vi } from "vitest";
import type { ReviewFlowResult } from "../agents/types";
import { createReviewService, MAX_REVIEW_PROMPT_LENGTH, parseReviewRequest, ReviewRequestError } from "./review-service";

const completed = (prompt: string): ReviewFlowResult => ({
  flowId: "core-review-test",
  status: "completed",
  finalOutput: prompt,
  steps: [],
});

describe("review service", () => {
  it("validates review requests without depending on an HTTP transport", () => {
    expect(parseReviewRequest({ prompt: "  review this  " })).toEqual({ prompt: "  review this  " });
    expect(() => parseReviewRequest({ prompt: "" })).toThrowError(ReviewRequestError);
    expect(() => parseReviewRequest({ prompt: "x".repeat(MAX_REVIEW_PROMPT_LENGTH + 1) })).toThrow(
      `Prompt must be ${MAX_REVIEW_PROMPT_LENGTH} characters or fewer`,
    );
  });

  it("delegates execution through the core service boundary", async () => {
    const runFlow = vi.fn(async (prompt: string) => completed(prompt));
    const service = createReviewService(runFlow);
    const request = service.parseRequest({ prompt: "framework independent" });

    const result = await service.run(request);

    expect(runFlow).toHaveBeenCalledWith("framework independent", {});
    expect(result).toEqual(completed("framework independent"));
  });

  it("forwards cancellation and logging options to the flow runner", async () => {
    const controller = new AbortController();
    const log = vi.fn();
    const runFlow = vi.fn(async (prompt: string) => completed(prompt));
    const service = createReviewService(runFlow);

    await service.run({ prompt: "options" }, { signal: controller.signal, log });

    expect(runFlow).toHaveBeenCalledWith("options", { signal: controller.signal, log });
  });
});
