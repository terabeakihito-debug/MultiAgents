import { flowStepIds, type AgentId, type FlowStepId } from "../agents/types";
import { FLOW_STEP_DEFINITIONS, type FlowStepAgentPlan } from "./step-agents";

export type FlowStepModelPlan = Record<FlowStepId, string>;

export const AGENT_MODEL_OPTIONS: Readonly<Record<AgentId, ReadonlyArray<{ id: string; label: string }>>> = {
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
  cursor: [
    { id: "auto", label: "Auto" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ],
  claude: [
    { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  ],
};

export function modelsAllowedForAgent(agent: AgentId): ReadonlyArray<{ id: string; label: string }> {
  return AGENT_MODEL_OPTIONS[agent];
}

export function defaultModelForAgent(agent: AgentId): string {
  return AGENT_MODEL_OPTIONS[agent][0]?.id ?? "";
}

export function defaultFlowStepModels(agentPlan: FlowStepAgentPlan): FlowStepModelPlan {
  return Object.fromEntries(
    FLOW_STEP_DEFINITIONS.map((step) => [step.id, defaultModelForAgent(agentPlan[step.id])]),
  ) as FlowStepModelPlan;
}

export function modelAllowedForAgent(agent: AgentId, modelId: string): boolean {
  return AGENT_MODEL_OPTIONS[agent].some((option) => option.id === modelId);
}

export class FlowStepModelPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowStepModelPlanError";
  }
}

export function parseFlowStepModelPlan(
  input: unknown,
  agentPlan: FlowStepAgentPlan,
): FlowStepModelPlan {
  const defaults = defaultFlowStepModels(agentPlan);
  if (input === undefined) return defaults;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FlowStepModelPlanError("Step model selection is invalid");
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !flowStepIds.includes(key as FlowStepId))) {
    throw new FlowStepModelPlanError("Step model selection contains an unknown step");
  }
  const plan = { ...defaults };
  for (const stepId of flowStepIds) {
    const value = body[stepId];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 120) {
      throw new FlowStepModelPlanError(`Model for ${stepId} is invalid`);
    }
    const agent = agentPlan[stepId];
    if (!modelAllowedForAgent(agent, value)) {
      throw new FlowStepModelPlanError(`Model ${value} is not allowed for ${agent} on ${stepId}`);
    }
    plan[stepId] = value;
  }
  for (const stepId of flowStepIds) {
    const agent = agentPlan[stepId];
    if (!modelAllowedForAgent(agent, plan[stepId])) {
      throw new FlowStepModelPlanError(`Model for ${stepId} is not allowed for agent ${agent}`);
    }
  }
  return plan;
}
