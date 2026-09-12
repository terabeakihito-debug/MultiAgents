import { rerunnableStepIds, type FlowStep } from "../agents/types";

export function canRerunFailedReviewStep(step: FlowStep, rerunAvailable: boolean) {
  return rerunAvailable && ["error", "stale"].includes(step.status) && rerunnableStepIds.includes(step.id);
}
