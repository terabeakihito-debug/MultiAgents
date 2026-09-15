import {
  getTask,
  getTaskDiff,
  initializeTaskRecovery,
  publicTask,
  type RepoTask,
  type TaskDiff,
} from "../server/tasks";

export class TaskDetailNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskDetailNotFoundError";
  }
}

export type TaskDetailResult = {
  task: ReturnType<typeof publicTask>;
  diff: TaskDiff;
  error?: string;
  conflict: boolean;
};

const unavailableWorktreeDiff: TaskDiff = {
  trackedFiles: [],
  untrackedFiles: [],
  stat: "",
  patch: "",
  untrackedPatch: "",
  truncated: false,
  approvable: false,
  blockedReason: "Managed task worktree is unavailable in this review-only session.",
};

type TaskDetailDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  getDiff: typeof getTaskDiff;
  toPublic: typeof publicTask;
};

export function createTaskDetailService(dependencies: TaskDetailDependencies = {
  initializeRecovery: initializeTaskRecovery,
  get: getTask,
  getDiff: getTaskDiff,
  toPublic: publicTask,
}) {
  return {
    async load(id: string): Promise<TaskDetailResult> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(id);
      if (!task) throw new TaskDetailNotFoundError();

      const projected = dependencies.toPublic(task);
      if (!task.worktreeAvailable) {
        return { task: projected, diff: unavailableWorktreeDiff, conflict: false };
      }

      try {
        return { task: projected, diff: await dependencies.getDiff(task), conflict: false };
      } catch (error) {
        // Preserve the existing route behavior exactly: after an initial diff
        // failure, one second diff read is attempted for the conflict payload.
        return {
          task: projected,
          diff: await dependencies.getDiff(task),
          error: error instanceof Error ? error.message : "Could not load task diff",
          conflict: true,
        };
      }
    },
  };
}

/** Framework-independent task detail read boundary used by transport adapters. */
export const taskDetailService = createTaskDetailService();

export type { RepoTask };
