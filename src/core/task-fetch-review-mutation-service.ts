import { fetchReviewIntake } from "../server/pr-review";
import { ApprovalError } from "../server/pull-request";
import { initializeTaskRecovery } from "../server/tasks";

type TaskFetchReviewMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  fetchReview: typeof fetchReviewIntake;
};

export function createTaskFetchReviewMutationService(
  dependencies: TaskFetchReviewMutationDependencies = {
    initialize: initializeTaskRecovery,
    fetchReview: fetchReviewIntake,
  },
) {
  return {
    async apply(taskId: string) {
      await dependencies.initialize();
      const task = await dependencies.fetchReview(taskId);
      return { task };
    },
  };
}

/** Framework-independent task fetch-review mutation used by transport adapters. */
export const taskFetchReviewMutationService =
  createTaskFetchReviewMutationService();

export { ApprovalError };
