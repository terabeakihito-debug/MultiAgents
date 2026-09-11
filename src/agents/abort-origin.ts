const reviewFlowTimeoutBrand = Symbol("multiagents.review-flow-timeout");

/**
 * An unforgeable, content-free reason used only for the review flow's own
 * deadline. Its message is diagnostic text, never provenance.
 */
export type ReviewFlowTimeoutAbortReason = Readonly<{
  readonly [reviewFlowTimeoutBrand]: true;
  message: string;
}>;

export const REVIEW_FLOW_TIMEOUT_MESSAGE = "Review flow timed out";

export function reviewFlowTimeoutAbortReason(message = REVIEW_FLOW_TIMEOUT_MESSAGE): ReviewFlowTimeoutAbortReason {
  return Object.freeze({ [reviewFlowTimeoutBrand]: true as const, message });
}

export function isReviewFlowTimeoutAbortReason(value: unknown): value is ReviewFlowTimeoutAbortReason {
  return Boolean(value && typeof value === "object" && (value as Partial<ReviewFlowTimeoutAbortReason>)[reviewFlowTimeoutBrand] === true);
}
