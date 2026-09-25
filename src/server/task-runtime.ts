import type { AgentAdapter, AgentId, AgentResult, FlowStepId } from "../agents/types";
import type { FlowStepModelPlan } from "../flows/agent-models";
import type { RuntimePolicy } from "../runtime/types";
import { buildTaskRuntimePolicies, runTaskAgentWithPolicy } from "./runtime-policy";
import { withProviderWorkBoundary } from "./provider-work-boundary";
import { markRuntimeViolation, recordAgentLifecycle, recordOsSandboxAudit, recordRuntimeAudit, type RepoTask } from "./tasks";

export async function prepareTaskRuntime(task: RepoTask) {
  const policies = await buildTaskRuntimePolicies(task);
  return {
    policies,
    execute: (adapter: AgentAdapter, prompt: string, signal?: AbortSignal, stepId?: string, onProviderWorkStart?: () => boolean | void, onChildClose?: () => void, model?: string): Promise<AgentResult> => {
      const policy = policies[adapter.id];
      return executePolicy(adapter, policy, prompt, signal, stepId, onProviderWorkStart, onChildClose, model);
    },
    executePolicy: (adapter: AgentAdapter, policy: RuntimePolicy, prompt: string, signal?: AbortSignal, stepId?: string, onProviderWorkStart?: () => boolean | void, onChildClose?: () => void, model?: string): Promise<AgentResult> => {
      return executePolicy(adapter, policy, prompt, signal, stepId, onProviderWorkStart, onChildClose, model);
    },
  };

  function executePolicy(adapter: AgentAdapter, policy: RuntimePolicy, prompt: string, signal?: AbortSignal, stepId?: string, onProviderWorkStart?: () => boolean | void, onChildClose?: () => void, model?: string) {
      let providerWorkRejected = false;
      const operation = () => runTaskAgentWithPolicy({
        task, adapter, policy, prompt, signal, stepId, model,
        onAudit: (type, activePolicy, violation) => recordRuntimeAudit(task, type, activePolicy, stepId, violation),
        onViolation: (activePolicy, violation) => markRuntimeViolation(task, activePolicy, violation),
        onSandboxAudit: (event) => {
          if (providerWorkRejected && event.type === "os_sandbox_failed" && event.failureCode === "sandbox_launch_failed") return;
          return recordOsSandboxAudit(task, event, stepId);
        },
        onLifecycleTelemetry: (telemetry) => recordAgentLifecycle(task, policy.agent, telemetry, stepId),
        onChildClose,
      });
      if (!onProviderWorkStart) return operation();
      return withProviderWorkBoundary(() => {
        const allowed = onProviderWorkStart();
        providerWorkRejected = allowed === false || signal?.aborted === true;
        return providerWorkRejected ? false : true;
      }, operation);
  }
}

export function taskRuntimeExecutor(runtime: Awaited<ReturnType<typeof prepareTaskRuntime>>, adapters: Record<AgentId, AgentAdapter>) {
  return (agent: AgentId, prompt: string, signal: AbortSignal, stepId: string, onProviderWorkStart?: () => boolean | void, onChildClose?: () => void, model?: string) =>
    runtime.execute(adapters[agent], prompt, signal, stepId, onProviderWorkStart, onChildClose, model);
}

export function taskRuntimeExecutorForStepModels(
  runtime: Awaited<ReturnType<typeof prepareTaskRuntime>>,
  adapters: Record<AgentId, AgentAdapter>,
  stepModels?: FlowStepModelPlan,
) {
  const execute = taskRuntimeExecutor(runtime, adapters);
  return (agent: AgentId, prompt: string, signal: AbortSignal, stepId: string, onProviderWorkStart?: () => boolean | void, onChildClose?: () => void) => {
    const model = stepModels?.[stepId as FlowStepId];
    return execute(agent, prompt, signal, stepId, onProviderWorkStart, onChildClose, model);
  };
}

export type TaskRuntime = { policies: Record<AgentId, RuntimePolicy> };
