import { describe, expect, it, vi } from "vitest";
import {
  createReviewFlowMutationService,
  ReviewRequestError,
} from "./review-flow-mutation-service";

describe("review flow mutation service", () => {
  it("parses and runs a review flow", async () => {
    const parse = vi.fn(() => ({ prompt: "Review this" }));
    const run = vi.fn(async () => ({ flowId: "flow-1", steps: [] })) as never;
    const service = createReviewFlowMutationService({ parse, run });

    await expect(service.apply({ prompt: "Review this" })).resolves.toEqual({
      flowId: "flow-1",
      steps: [],
    });
    expect(run).toHaveBeenCalledWith(
      { prompt: "Review this" },
      expect.objectContaining({ log: expect.any(Function) }),
    );
  });

  it("surfaces ReviewRequestError from parsing", async () => {
    const service = createReviewFlowMutationService({
      parse: vi.fn(() => {
        throw new ReviewRequestError("prompt_required", "Prompt is required");
      }),
      run: vi.fn(),
    });

    await expect(service.apply({})).rejects.toBeInstanceOf(ReviewRequestError);
  });
});
