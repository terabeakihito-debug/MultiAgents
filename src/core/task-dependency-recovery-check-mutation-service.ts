import {
  checkTaskDependencies,
  DependencyReadinessError,
} from "../server/pull-request";
import {
  getTask,
  initializeTaskRecovery,
  type RepoTask,
} from "../server/tasks";
import {
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
} from "./dependency-recovery-service";

export type DependencyReadinessCheck = {
  status: "ready" | "missing" | "error";
  message: string;
  checkedAt: string;
};

type TaskDependencyRecoveryCheckDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  checkDependencies: typeof checkTaskDependencies;
};

export function createTaskDependencyRecoveryCheckMutationService(
  dependencies: TaskDependencyRecoveryCheckDependencies = {
    initializeRecovery: initializeTaskRecovery,
    get: getTask,
    checkDependencies: checkTaskDependencies,
  },
) {
  return {
    async apply(taskId: string): Promise<DependencyReadinessCheck> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(taskId);
      if (!task) throw new DependencyRecoveryTaskNotFoundError();
      if (!task.worktreeAvailable || task.worktreeStatus !== "available") {
        throw new DependencyRecoveryUnavailableError();
      }

      const checkedAt = new Date().toISOString();
      try {
        await dependencies.checkDependencies(task);
        return {
          status: "ready",
          message: "依存関係を確認しました。node_modules と npm ls --offline は正常です。",
          checkedAt,
        };
      } catch (error) {
        if (error instanceof DependencyReadinessError) {
          return {
            status: "missing",
            message: "依存関係は未準備です。node_modules がないか、npm ls --offline が失敗しました。",
            checkedAt,
          };
        }
        return {
          status: "error",
          message: "依存関係を確認できませんでした。作業ツリーまたは npm のエラーです。",
          checkedAt,
        };
      }
    },
  };
}

export const taskDependencyRecoveryCheckMutationService =
  createTaskDependencyRecoveryCheckMutationService();

export {
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
};

export type { RepoTask };
