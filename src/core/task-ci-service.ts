import {
  getTask,
  initializeTaskRecovery,
  publicTask,
  type RepoTask,
} from "../server/tasks";

export class TaskCiNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskCiNotFoundError";
  }
}

export type TaskCiResult = {
  task: ReturnType<typeof publicTask>;
  checks: NonNullable<RepoTask["prReview"]>["checks"];
  message: RepoTask["ciMessage"];
};

type TaskCiDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  toPublic: typeof publicTask;
};

export function createTaskCiService(dependencies: TaskCiDependencies = {
  initializeRecovery: initializeTaskRecovery,
  get: getTask,
  toPublic: publicTask,
}) {
  return {
    async load(id: string): Promise<TaskCiResult> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(id);
      if (!task) throw new TaskCiNotFoundError();

      return {
        task: dependencies.toPublic(task),
        checks: task.prReview?.checks ?? [],
        message: task.ciMessage,
      };
    },
  };
}

/** Framework-independent task CI read boundary used by transport adapters. */
export const taskCiService = createTaskCiService();

export type { RepoTask };
