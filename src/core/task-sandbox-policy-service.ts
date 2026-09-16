import type { AgentId } from "../agents/types";
import {
  publicOsSandboxPolicy,
  type PublicOsSandboxPolicy,
} from "../server/os-sandbox";
import { buildTaskRuntimePolicies } from "../server/runtime-policy";
import {
  getTask,
  initializeTaskRecovery,
  type RepoTask,
} from "../server/tasks";

export class TaskSandboxPolicyNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskSandboxPolicyNotFoundError";
  }
}

export class TaskSandboxPolicyUnavailableError extends Error {
  constructor(message = "OS sandbox policy is unavailable") {
    super(message);
    this.name = "TaskSandboxPolicyUnavailableError";
  }
}

export type TaskSandboxPolicyAgent = PublicOsSandboxPolicy & {
  agent: AgentId;
};

export type TaskSandboxPolicyResult = {
  status: "enforced";
  validation: PublicOsSandboxPolicy;
  agents: TaskSandboxPolicyAgent[];
};

type TaskSandboxPolicyDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  buildPolicies: typeof buildTaskRuntimePolicies;
  toPublic: typeof publicOsSandboxPolicy;
};

export function createTaskSandboxPolicyService(
  dependencies: TaskSandboxPolicyDependencies = {
    initializeRecovery: initializeTaskRecovery,
    get: getTask,
    buildPolicies: buildTaskRuntimePolicies,
    toPublic: publicOsSandboxPolicy,
  },
) {
  return {
    async load(id: string): Promise<TaskSandboxPolicyResult> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(id);
      if (!task) throw new TaskSandboxPolicyNotFoundError();

      try {
        const policies = await dependencies.buildPolicies(task);
        return {
          status: "enforced",
          validation: dependencies.toPublic("validation"),
          agents: Object.values(policies)
            .filter((policy) => policy.role !== "disabled")
            .map((policy) => ({
              agent: policy.agent,
              ...dependencies.toPublic(policy.osSandboxProfile),
            })),
        };
      } catch (error) {
        throw new TaskSandboxPolicyUnavailableError(
          error instanceof Error ? error.message : "OS sandbox policy is unavailable",
        );
      }
    },
  };
}

/** Framework-independent task sandbox-policy read boundary used by transport adapters. */
export const taskSandboxPolicyService = createTaskSandboxPolicyService();

export type { RepoTask };
