import {
  getTask,
  getTaskHistory,
  initializeTaskRecovery,
  type RepoTask,
} from "../server/tasks";

export class TaskHistoryNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskHistoryNotFoundError";
  }
}

export type TaskHistoryResult = {
  history: ReturnType<typeof getTaskHistory>;
};

type TaskHistoryDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  getHistory: typeof getTaskHistory;
};

export function createTaskHistoryService(dependencies: TaskHistoryDependencies = {
  initializeRecovery: initializeTaskRecovery,
  get: getTask,
  getHistory: getTaskHistory,
}) {
  return {
    async load(id: string): Promise<TaskHistoryResult> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(id);
      if (!task) throw new TaskHistoryNotFoundError();

      return {
        history: dependencies.getHistory(task.id),
      };
    },
  };
}

/** Framework-independent task history read boundary used by transport adapters. */
export const taskHistoryService = createTaskHistoryService();

export type { RepoTask };
