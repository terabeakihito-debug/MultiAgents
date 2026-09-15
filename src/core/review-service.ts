import { runReviewFlow } from "../flows/review";
import type { ReviewFlowResult } from "../agents/types";

export const MAX_REVIEW_PROMPT_LENGTH = 20_000;

export type ReviewRequest = {
  prompt: string;
};

export type ReviewRequestErrorCode = "prompt_required" | "prompt_too_long";

export class ReviewRequestError extends Error {
  constructor(
    readonly code: ReviewRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewRequestError";
  }
}

type ReviewFlowOptions = Parameters<typeof runReviewFlow>[1];
type ReviewFlowRunner = (prompt: string, options?: ReviewFlowOptions) => Promise<ReviewFlowResult>;

export function parseReviewRequest(input: unknown): ReviewRequest {
  const prompt = (input as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new ReviewRequestError("prompt_required", "Prompt is required");
  }
  if (prompt.length > MAX_REVIEW_PROMPT_LENGTH) {
    throw new ReviewRequestError("prompt_too_long", `Prompt must be ${MAX_REVIEW_PROMPT_LENGTH} characters or fewer`);
  }
  return { prompt };
}

export function createReviewService(runFlow: ReviewFlowRunner = runReviewFlow) {
  return {
    parseRequest: parseReviewRequest,
    async run(request: ReviewRequest, options: ReviewFlowOptions = {}): Promise<ReviewFlowResult> {
      return runFlow(request.prompt, options);
    },
  };
}

/** Framework-independent review execution boundary used by transport adapters. */
export const reviewService = createReviewService();
