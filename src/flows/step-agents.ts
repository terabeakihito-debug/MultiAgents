import {
  agentIds,
  flowStepIds,
  type AgentId,
  type FlowRole,
  type FlowStep,
  type FlowStepId,
} from "../agents/types";
import type { AgentRole, ProjectProfileSnapshot } from "../profiles/policy";
import type { TaskTemplateSnapshot } from "../templates/policy";

export type FlowStepAgentPlan = Record<FlowStepId, AgentId>;

export const FLOW_STEP_DEFINITIONS: ReadonlyArray<{ id: FlowStepId; agent: AgentId; role: FlowRole }> = [
  { id: "codex_draft", agent: "codex", role: "draft" },
  { id: "cursor_review", agent: "cursor", role: "review" },
  { id: "claude_review", agent: "claude", role: "review" },
  { id: "codex_final", agent: "codex", role: "final" },
];

export function defaultFlowStepAgents(): FlowStepAgentPlan {
  return Object.fromEntries(FLOW_STEP_DEFINITIONS.map((step) => [step.id, step.agent])) as FlowStepAgentPlan;
}

function effectiveAgentRole(
  agent: AgentId,
  profile: ProjectProfileSnapshot,
  template: TaskTemplateSnapshot,
): AgentRole {
  const profileRole = profile.roles[agent];
  const templateRole = template.roles[agent];
  if (profileRole === "disabled" || templateRole === "disabled") return "disabled";
  if (profileRole === "review_only" || templateRole === "review_only") return "review_only";
  return "implement";
}

export function agentsAllowedForFlowStep(
  stepRole: FlowRole,
  readOnly: boolean,
  profile: ProjectProfileSnapshot,
  template: TaskTemplateSnapshot,
): AgentId[] {
  return agentIds.filter((agent) => {
    const role = effectiveAgentRole(agent, profile, template);
    if (role === "disabled") return false;
    if (stepRole === "review") return true;
    if (readOnly) return role === "review_only";
    return role === "implement";
  });
}

export class FlowStepAgentPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowStepAgentPlanError";
  }
}

export function parseFlowStepAgentPlan(
  input: unknown,
  profile: ProjectProfileSnapshot,
  template: TaskTemplateSnapshot,
): FlowStepAgentPlan {
  const defaults = defaultFlowStepAgents();
  if (input === undefined) return defaults;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FlowStepAgentPlanError("Step agent selection is invalid");
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !flowStepIds.includes(key as FlowStepId))) {
    throw new FlowStepAgentPlanError("Step agent selection contains an unknown step");
  }
  const plan = { ...defaults };
  for (const stepId of flowStepIds) {
    const value = body[stepId];
    if (value === undefined) continue;
    if (typeof value !== "string" || !agentIds.includes(value as AgentId)) {
      throw new FlowStepAgentPlanError(`Agent for ${stepId} is invalid`);
    }
    plan[stepId] = value as AgentId;
  }
  for (const definition of FLOW_STEP_DEFINITIONS) {
    const allowed = agentsAllowedForFlowStep(definition.role, template.readOnly, profile, template);
    if (!allowed.includes(plan[definition.id])) {
      throw new FlowStepAgentPlanError(`Agent ${plan[definition.id]} cannot run ${definition.id} for this project`);
    }
  }
  return plan;
}

export function buildInitialFlowSteps(plan: FlowStepAgentPlan = defaultFlowStepAgents()): FlowStep[] {
  return FLOW_STEP_DEFINITIONS.map((definition) => ({
    id: definition.id,
    agent: plan[definition.id] ?? definition.agent,
    role: definition.role,
    status: "idle",
    output: "",
  }));
}
