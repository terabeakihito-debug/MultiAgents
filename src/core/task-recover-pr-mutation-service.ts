import { recoverExistingPullRequestTask } from "../server/pr-review";
import { ApprovalError } from "../server/pull-request";
import {
  initializeTaskRecovery,
  listTasks,
  publicTask,
} from "../server/tasks";

type TaskRecoverPrMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  list: typeof listTasks;
  recover: typeof recoverExistingPullRequestTask;
  toPublicTask: typeof publicTask;
};

export class TaskRecoverPrInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRecoverPrInputError";
  }
}

function parseRecoverPrBody(body: unknown) {
  const value = body as { repoId?: unknown; prNumber?: unknown };
  if (
    typeof value.repoId !== "string" ||
    !Number.isSafeInteger(value.prNumber) ||
    Number(value.prNumber) < 1
  ) {
    throw new TaskRecoverPrInputError(
      "Repository and numeric PR number are required",
    );
  }
  return { repoId: value.repoId, prNumber: Number(value.prNumber) };
}

export function createTaskRecoverPrMutationService(
  dependencies: TaskRecoverPrMutationDependencies = {
    initialize: initializeTaskRecovery,
    list: listTasks,
    recover: recoverExistingPullRequestTask,
    toPublicTask: publicTask,
  },
) {
  return {
    async apply(body: unknown) {
      await dependencies.initialize();
      const input = parseRecoverPrBody(body);
      const existing = dependencies
        .list()
        .find(
          (task) =>
            task.repoId === input.repoId && task.prNumber === input.prNumber,
        );
      if (
        existing &&
        existing.repoId === input.repoId &&
        existing.prNumber === input.prNumber
      ) {
        return { task: dependencies.toPublicTask(existing) };
      }
      const task = await dependencies.recover(input.repoId, input.prNumber);
      return { task };
    },
  };
}

/** Framework-independent task recover-pr mutation used by transport adapters. */
export const taskRecoverPrMutationService = createTaskRecoverPrMutationService();

export { ApprovalError };
