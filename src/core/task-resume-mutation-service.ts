import { prepareApproval } from "../server/pull-request";
import {
  getTask,
  getTaskDiff,
  publicTask,
  resumeTask,
} from "../server/tasks";

type TaskResumeMutationDependencies = {
  resume: typeof resumeTask;
  loadTask: typeof getTask;
  prepare: typeof prepareApproval;
  loadDiff: typeof getTaskDiff;
  toPublicTask: typeof publicTask;
};

export function createTaskResumeMutationService(
  dependencies: TaskResumeMutationDependencies = {
    resume: resumeTask,
    loadTask: getTask,
    prepare: prepareApproval,
    loadDiff: getTaskDiff,
    toPublicTask: publicTask,
  },
) {
  return {
    async apply(taskId: string) {
      try {
        const task = await dependencies.resume(taskId);
        if (!task) {
          return {
            status: 404 as const,
            body: { error: "Task not found" },
          };
        }
        if (!task.worktreeAvailable) {
          return {
            status: 200 as const,
            body: { task: dependencies.toPublicTask(task) },
          };
        }
        const prepared = await dependencies.prepare(task);
        return {
          status: 200 as const,
          body: { ...prepared, task: dependencies.toPublicTask(task) },
        };
      } catch (error) {
        const task = dependencies.loadTask(taskId);
        const message =
          error instanceof Error ? error.message : "Task resume failed";
        if (!task?.worktreeAvailable) {
          return {
            status: 409 as const,
            body: {
              task: task ? dependencies.toPublicTask(task) : undefined,
              error: message,
            },
          };
        }
        return {
          status: 409 as const,
          body: {
            task: dependencies.toPublicTask(task),
            diff: await dependencies.loadDiff(task),
            error: message,
          },
        };
      }
    },
  };
}

/** Framework-independent task resume mutation used by transport adapters. */
export const taskResumeMutationService = createTaskResumeMutationService();
