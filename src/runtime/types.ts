import type { AgentId } from "../agents/types";
import type { AgentRole } from "../profiles/policy";

export const RUNTIME_POLICY_VERSION = 1 as const;

export type RuntimeFilesystemCapability = "repo_read" | "worktree_read" | "worktree_write";
export type RuntimeNetworkPolicy = "cli_managed";
export type RuntimeExecutionCapability = "agent_cli";
export type RuntimePolicyClass = "repository_implementation" | "repository_review" | "generic_read_only" | "disabled";
export type RuntimeViolation =
  | "unexpected_write"
  | "head_changed"
  | "branch_changed"
  | "base_repo_changed"
  | "worktree_escape"
  | "unexpected_worktree"
  | "forbidden_runtime_configuration";

export type RuntimePolicy = {
  version: typeof RUNTIME_POLICY_VERSION;
  agent: AgentId;
  role: AgentRole;
  policyClass: RuntimePolicyClass;
  filesystem: RuntimeFilesystemCapability[];
  networkPolicy: RuntimeNetworkPolicy;
  networkEnforcement: "not_guaranteed_by_multiagents";
  execution: RuntimeExecutionCapability[];
  allowWrite: boolean;
  /** Server-private validated realpath. Never serialize this field. */
  workingRoot: string;
  /** Server-private validated realpath. Never serialize this field. */
  writableRoot?: string;
  environmentPolicy: "agent";
  forbiddenOperations: string[];
  sourceProfileId?: string;
  sourceProfileVersion?: number;
  sourceTemplateId?: string;
  sourceTemplateVersion?: number;
  source: "task_snapshots" | "parallel_generic";
  policyHash: string;
};

export type PublicRuntimePolicy = Omit<RuntimePolicy, "workingRoot" | "writableRoot" | "forbiddenOperations"> & {
  writeScope: "task_worktree_only" | "denied";
  forbiddenOperations: string[];
};

export type RuntimeViolationRecord = {
  type: RuntimeViolation;
  agent: AgentId;
  role: AgentRole;
  policyClass: RuntimePolicyClass;
  message: string;
};

export type RuntimeExecutionResult = {
  violations: RuntimeViolation[];
};
