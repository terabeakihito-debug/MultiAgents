import type { AgentId } from "../agents/types";
import { RUNTIME_POLICY_VERSION } from "../runtime/types";
import {
  publicOsSandboxPolicy,
  type PublicOsSandboxPolicy,
} from "../server/os-sandbox";
import {
  buildTaskRuntimePolicies,
  publicRuntimePolicy,
} from "../server/runtime-policy";
import {
  getTask,
  initializeTaskRecovery,
  requireTaskTemplate,
  type RepoTask,
} from "../server/tasks";

export const TASK_RUNTIME_NETWORK_ENFORCEMENT_DESCRIPTION =
  "Validation network is denied by an OS namespace. Agent network remains provider-required residual risk.";

export class TaskRuntimePolicyNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskRuntimePolicyNotFoundError";
  }
}

export class TaskRuntimePolicyUnavailableError extends Error {
  constructor(message = "Runtime policy is unavailable") {
    super(message);
    this.name = "TaskRuntimePolicyUnavailableError";
  }
}

export type TaskRuntimePolicyResult = {
  runtimePolicyVersion: typeof RUNTIME_POLICY_VERSION;
  taskType: ReturnType<typeof requireTaskTemplate>["taskType"];
  allAgentsReadOnly: boolean;
  worktreeRequired: boolean;
  networkEnforcementDescription: typeof TASK_RUNTIME_NETWORK_ENFORCEMENT_DESCRIPTION;
  osSandbox: {
    status: "enforced";
    validation: PublicOsSandboxPolicy;
    agents: Array<PublicOsSandboxPolicy & { agent: AgentId }>;
  };
  policies: ReturnType<typeof publicRuntimePolicy>[];
};

type TaskRuntimePolicyDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  get: typeof getTask;
  requireTemplate: typeof requireTaskTemplate;
  buildPolicies: typeof buildTaskRuntimePolicies;
  toPublicSandbox: typeof publicOsSandboxPolicy;
  toPublicPolicy: typeof publicRuntimePolicy;
};

export function createTaskRuntimePolicyService(
  dependencies: TaskRuntimePolicyDependencies = {
    initializeRecovery: initializeTaskRecovery,
    get: getTask,
    requireTemplate: requireTaskTemplate,
    buildPolicies: buildTaskRuntimePolicies,
    toPublicSandbox: publicOsSandboxPolicy,
    toPublicPolicy: publicRuntimePolicy,
  },
) {
  return {
    async load(id: string): Promise<TaskRuntimePolicyResult> {
      await dependencies.initializeRecovery();
      const task = dependencies.get(id);
      if (!task) throw new TaskRuntimePolicyNotFoundError();

      try {
        const template = dependencies.requireTemplate(task);
        const policies = await dependencies.buildPolicies(task);
        return {
          runtimePolicyVersion: RUNTIME_POLICY_VERSION,
          taskType: template.taskType,
          allAgentsReadOnly: template.readOnly,
          worktreeRequired: template.requireWorktree,
          networkEnforcementDescription: TASK_RUNTIME_NETWORK_ENFORCEMENT_DESCRIPTION,
          osSandbox: {
            status: "enforced",
            validation: dependencies.toPublicSandbox("validation"),
            agents: Object.values(policies)
              .filter((policy) => policy.role !== "disabled")
              .map((policy) => ({
                agent: policy.agent,
                ...dependencies.toPublicSandbox(policy.osSandboxProfile),
              })),
          },
          policies: Object.values(policies).map(dependencies.toPublicPolicy),
        };
      } catch (error) {
        throw new TaskRuntimePolicyUnavailableError(
          error instanceof Error ? error.message : "Runtime policy is unavailable",
        );
      }
    },
  };
}

/** Framework-independent task runtime-policy read boundary used by transport adapters. */
export const taskRuntimePolicyService = createTaskRuntimePolicyService();

export type { RepoTask };
