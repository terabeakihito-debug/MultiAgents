const reviewFlowTimeoutBrand = Symbol("multiagents.review-flow-timeout");
const reviewStepBudgetBrand = Symbol("multiagents.review-step-budget");

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

/** A content-free provenance marker for a review step's allocated work budget. */
export type ReviewStepBudgetAbortReason = Readonly<{
  readonly [reviewStepBudgetBrand]: true;
  message: string;
}>;

export const REVIEW_STEP_BUDGET_MESSAGE = "Review step budget exhausted";

export function reviewStepBudgetAbortReason(message = REVIEW_STEP_BUDGET_MESSAGE): ReviewStepBudgetAbortReason {
  return Object.freeze({ [reviewStepBudgetBrand]: true as const, message });
}

export function isReviewStepBudgetAbortReason(value: unknown): value is ReviewStepBudgetAbortReason {
  return Boolean(value && typeof value === "object" && (value as Partial<ReviewStepBudgetAbortReason>)[reviewStepBudgetBrand] === true);
}
