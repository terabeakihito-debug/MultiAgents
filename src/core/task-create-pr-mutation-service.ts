import { ApprovalError, retryPullRequest } from "../server/pull-request";
import { initializeTaskRecovery } from "../server/tasks";

type TaskCreatePrMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  retryPullRequest: typeof retryPullRequest;
};

export function createTaskCreatePrMutationService(
  dependencies: TaskCreatePrMutationDependencies = {
    initialize: initializeTaskRecovery,
    retryPullRequest,
  },
) {
  return {
    async apply(taskId: string) {
      await dependencies.initialize();
      const task = await dependencies.retryPullRequest(taskId);
      return { task };
    },
  };
}

/** Framework-independent task create-pr mutation used by transport adapters. */
export const taskCreatePrMutationService = createTaskCreatePrMutationService();

export { ApprovalError };
