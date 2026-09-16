import { prepareApproval } from "../server/pull-request";
import {
  getTask,
  getTaskDiff,
  initializeTaskRecovery,
  publicTask,
} from "../server/tasks";

type TaskPrepareApprovalMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  loadTask: typeof getTask;
  prepare: typeof prepareApproval;
  loadDiff: typeof getTaskDiff;
  toPublicTask: typeof publicTask;
};

const worktreeUnavailableBody = (task: NonNullable<ReturnType<typeof getTask>>) => ({
  diff: {
    trackedFiles: [],
    untrackedFiles: [],
    stat: "",
    patch: "",
    untrackedPatch: "",
    truncated: false,
    approvable: false,
    blockedReason:
      "Managed task worktree is unavailable in this review-only session.",
  },
  task: publicTask(task),
});

export function createTaskPrepareApprovalMutationService(
  dependencies: TaskPrepareApprovalMutationDependencies = {
    initialize: initializeTaskRecovery,
    loadTask: getTask,
    prepare: prepareApproval,
    loadDiff: getTaskDiff,
    toPublicTask: publicTask,
  },
) {
  return {
    async apply(taskId: string) {
      await dependencies.initialize();
      const task = dependencies.loadTask(taskId);
      if (!task) {
        return { status: 404 as const, body: { error: "Task not found" } };
      }
      if (!task.worktreeAvailable) {
        return {
          status: 200 as const,
          body: worktreeUnavailableBody(task),
        };
      }
      try {
        return {
          status: 200 as const,
          body: await dependencies.prepare(task),
        };
      } catch (error) {
        return {
          status: 409 as const,
          body: {
            diff: await dependencies.loadDiff(task),
            task: dependencies.toPublicTask(task),
            error:
              error instanceof Error
                ? error.message
                : "Could not prepare approval",
          },
        };
      }
    },
  };
}

/** Framework-independent task prepare-approval mutation used by transport adapters. */
export const taskPrepareApprovalMutationService =
  createTaskPrepareApprovalMutationService();
