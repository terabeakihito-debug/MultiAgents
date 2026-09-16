import {
  dependencyRecoveryService,
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
} from "./dependency-recovery-service";

type TaskDependencyRecoveryInstructionsMutationDependencies = {
  load: typeof dependencyRecoveryService.load;
};

export function createTaskDependencyRecoveryInstructionsMutationService(
  dependencies: TaskDependencyRecoveryInstructionsMutationDependencies = {
    load: (taskId) => dependencyRecoveryService.load(taskId),
  },
) {
  return {
    apply(taskId: string) {
      return dependencies.load(taskId);
    },
  };
}

/** Framework-independent dependency recovery instructions mutation used by transport adapters. */
export const taskDependencyRecoveryInstructionsMutationService =
  createTaskDependencyRecoveryInstructionsMutationService();

export {
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
};
