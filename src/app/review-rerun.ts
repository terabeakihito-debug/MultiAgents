import { rerunnableStepIds, type FlowStep } from "../agents/types";

export function canRerunFailedReviewStep(step: FlowStep, rerunAvailable: boolean) {
  return rerunAvailable && step.status === "error" && rerunnableStepIds.includes(step.id);
}
