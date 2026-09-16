import { refreshPullRequestStatus } from "../server/pr-review";
import { ApprovalError } from "../server/pull-request";
import { initializeTaskRecovery } from "../server/tasks";

type TaskRefreshPrMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  refresh: typeof refreshPullRequestStatus;
};

export function createTaskRefreshPrMutationService(
  dependencies: TaskRefreshPrMutationDependencies = {
    initialize: initializeTaskRecovery,
    refresh: refreshPullRequestStatus,
  },
) {
  return {
    async apply(taskId: string) {
      await dependencies.initialize();
      const task = await dependencies.refresh(taskId);
      return { task };
    },
  };
}

/** Framework-independent task refresh-pr mutation used by transport adapters. */
export const taskRefreshPrMutationService = createTaskRefreshPrMutationService();

export { ApprovalError };
