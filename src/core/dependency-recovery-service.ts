import { dependencyRecoveryInstructions } from "../server/dependency-recovery";
import {
  getTask,
  initializeTaskRecovery,
  type RepoTask,
} from "../server/tasks";

export class DependencyRecoveryTaskNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "DependencyRecoveryTaskNotFoundError";
  }
}

export class DependencyRecoveryUnavailableError extends Error {
  constructor() {
    super("Dependency recovery instructions are unavailable for this task");
    this.name = "DependencyRecoveryUnavailableError";
  }
}

export type DependencyRecoveryResult = ReturnType<typeof dependencyRecoveryInstructions>;

type DependencyRecoveryDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  buildInstructions: typeof dependencyRecoveryInstructions;
};

export function createDependencyRecoveryService(
  dependencies: DependencyRecoveryDependencies = {
    initializeRecovery: initializeTaskRecovery,
    get: getTask,
    buildInstructions: dependencyRecoveryInstructions,
  },
) {
  return {
    async load(id: string): Promise<NonNullable<DependencyRecoveryResult>> {
      await dependencies.initializeRecovery();

      const task = dependencies.get(id);
      if (!task) throw new DependencyRecoveryTaskNotFoundError();

      const instructions = dependencies.buildInstructions(task);
      if (!instructions) throw new DependencyRecoveryUnavailableError();

      return instructions;
    },
  };
}

/** Framework-independent dependency recovery instruction boundary used by transport adapters. */
export const dependencyRecoveryService = createDependencyRecoveryService();

export type { RepoTask };
