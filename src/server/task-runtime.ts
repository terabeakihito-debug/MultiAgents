import type { AgentAdapter, AgentId, AgentResult } from "../agents/types";
import type { RuntimePolicy } from "../runtime/types";
import { buildTaskRuntimePolicies, runTaskAgentWithPolicy } from "./runtime-policy";
import { markRuntimeViolation, recordOsSandboxAudit, recordRuntimeAudit, type RepoTask } from "./tasks";

export async function prepareTaskRuntime(task: RepoTask) {
  const policies = await buildTaskRuntimePolicies(task);
  return {
    policies,
    execute: (adapter: AgentAdapter, prompt: string, signal?: AbortSignal, stepId?: string): Promise<AgentResult> => {
      const policy = policies[adapter.id];
      return executePolicy(adapter, policy, prompt, signal, stepId);
    },
    executePolicy: (adapter: AgentAdapter, policy: RuntimePolicy, prompt: string, signal?: AbortSignal, stepId?: string): Promise<AgentResult> => {
      return executePolicy(adapter, policy, prompt, signal, stepId);
    },
  };

  function executePolicy(adapter: AgentAdapter, policy: RuntimePolicy, prompt: string, signal?: AbortSignal, stepId?: string) {
      return runTaskAgentWithPolicy({
        task, adapter, policy, prompt, signal, stepId,
        onAudit: (type, activePolicy, violation) => recordRuntimeAudit(task, type, activePolicy, stepId, violation),
        onViolation: (activePolicy, violation) => markRuntimeViolation(task, activePolicy, violation),
        onSandboxAudit: (event) => recordOsSandboxAudit(task, event, stepId),
      });
  }
}

export function taskRuntimeExecutor(runtime: Awaited<ReturnType<typeof prepareTaskRuntime>>, adapters: Record<AgentId, AgentAdapter>) {
  return (agent: AgentId, prompt: string, signal: AbortSignal, stepId: string) => runtime.execute(adapters[agent], prompt, signal, stepId);
}

export type TaskRuntime = { policies: Record<AgentId, RuntimePolicy> };
