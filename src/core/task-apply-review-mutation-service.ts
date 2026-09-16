import { applyReviewedFixes } from "../server/pr-review";
import { ApprovalError } from "../server/pull-request";
import { initializeTaskRecovery } from "../server/tasks";

type TaskApplyReviewMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  applyReview: typeof applyReviewedFixes;
};

export class TaskApplyReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskApplyReviewInputError";
  }
}

export function createTaskApplyReviewMutationService(
  dependencies: TaskApplyReviewMutationDependencies = {
    initialize: initializeTaskRecovery,
    applyReview: applyReviewedFixes,
  },
) {
  return {
    async apply(taskId: string, body: unknown) {
      await dependencies.initialize();
      if ((body as { approved?: unknown })?.approved !== true) {
        throw new TaskApplyReviewInputError(
          "Explicit human approval is required",
        );
      }
      const task = await dependencies.applyReview(taskId, { approved: true });
      return { task };
    },
  };
}

/** Framework-independent task apply-review mutation used by transport adapters. */
export const taskApplyReviewMutationService =
  createTaskApplyReviewMutationService();

export { ApprovalError };
