import {
  getTask,
  initializeTaskRecovery,
  publicTask,
  type RepoTask,
} from "../server/tasks";

export class TaskPrNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskPrNotFoundError";
  }
}

export class TaskPrConflictError extends Error {
  constructor() {
    super("Task does not have an existing pull request");
    this.name = "TaskPrConflictError";
  }
}

export type TaskPrResult = {
  task: ReturnType<typeof publicTask>;
  pullRequest: RepoTask["prReview"];
  intake: RepoTask["reviewIntake"];
};

type TaskPrDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  toPublic: typeof publicTask;
};

export function createTaskPrService(dependencies: TaskPrDependencies = {
  initializeRecovery: initializeTaskRecovery,
  get: getTask,
  toPublic: publicTask,
}) {
  return {
    async load(id: string): Promise<TaskPrResult> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(id);
      if (!task) throw new TaskPrNotFoundError();
      if (!task.prNumber) throw new TaskPrConflictError();

      return {
        task: dependencies.toPublic(task),
        pullRequest: task.prReview,
        intake: task.reviewIntake,
      };
    },
  };
}

/** Framework-independent task pull-request read boundary used by transport adapters. */
export const taskPrService = createTaskPrService();

export type { RepoTask };
