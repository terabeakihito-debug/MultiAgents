import {
  getTask,
  initializeTaskRecovery,
  requireTaskProfile,
  type RepoTask,
} from "../server/tasks";

export class TaskProfileNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskProfileNotFoundError";
  }
}

export class TaskProfileInvalidError extends Error {
  constructor(message = "Task profile snapshot is invalid") {
    super(message);
    this.name = "TaskProfileInvalidError";
  }
}

export type TaskProfileResult = {
  profile: ReturnType<typeof requireTaskProfile>;
};

type TaskProfileDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  requireProfile: typeof requireTaskProfile;
};

export function createTaskProfileService(dependencies: TaskProfileDependencies = {
  initializeRecovery: initializeTaskRecovery,
  get: getTask,
  requireProfile: requireTaskProfile,
}) {
  return {
    async load(id: string): Promise<TaskProfileResult> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(id);
      if (!task) throw new TaskProfileNotFoundError();

      try {
        return {
          profile: dependencies.requireProfile(task),
        };
      } catch (error) {
        throw new TaskProfileInvalidError(
          error instanceof Error ? error.message : "Task profile snapshot is invalid",
        );
      }
    },
  };
}

/** Framework-independent task profile read boundary used by transport adapters. */
export const taskProfileService = createTaskProfileService();

export type { RepoTask };
