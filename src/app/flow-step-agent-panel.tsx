"use client";

import { flowStepIds, type AgentId, type FlowStepId } from "@/agents/types";
import type { FlowStepModelPlan } from "@/flows/agent-models";
import { defaultFlowStepModels, defaultModelForAgent, modelsAllowedForAgent } from "@/flows/agent-models";
import type { FlowStepAgentPlan } from "@/flows/step-agents";
import { agentsAllowedForFlowStep, defaultFlowStepAgents, FLOW_STEP_DEFINITIONS } from "@/flows/step-agents";
import type { ProjectProfileSnapshot } from "@/profiles/policy";
import type { TaskTemplateSnapshot } from "@/templates/policy";

const agentLabels: Record<AgentId, string> = { codex: "Codex", cursor: "Cursor", claude: "Claude" };

const stepLabels: Record<(typeof flowStepIds)[number], string> = {
  codex_draft: "下書き",
  cursor_review: "レビュー 1",
  claude_review: "レビュー 2",
  codex_final: "最終確認",
};

export function FlowStepAgentPanel({
  profile,
  template,
  agents,
  models,
  disabled,
  onAgentsChange,
  onModelsChange,
}: {
  profile: ProjectProfileSnapshot;
  template: TaskTemplateSnapshot;
  agents: FlowStepAgentPlan;
  models: FlowStepModelPlan;
  disabled?: boolean;
  onAgentsChange: (plan: FlowStepAgentPlan) => void;
  onModelsChange: (plan: FlowStepModelPlan) => void;
}) {
  function resetDefaults() {
    const nextAgents = defaultFlowStepAgents();
    onAgentsChange(nextAgents);
    onModelsChange(defaultFlowStepModels(nextAgents));
  }

  function changeAgent(stepId: FlowStepId, agent: AgentId) {
    onAgentsChange({ ...agents, [stepId]: agent });
    const allowed = modelsAllowedForAgent(agent);
    if (!allowed.some((option) => option.id === models[stepId])) {
      onModelsChange({ ...models, [stepId]: defaultModelForAgent(agent) });
    }
  }

  return <section className="flowStepAgentPanel" aria-labelledby="flow-step-agents-title">
    <div className="profileHeading">
      <div>
        <span className="eyebrow">実行</span>
        <h3 id="flow-step-agents-title">ステップごとの担当エージェント</h3>
      </div>
      <button type="button" className="secondary compactButton" disabled={disabled} onClick={resetDefaults}>既定に戻す</button>
    </div>
    <p className="muted">レビュー方式の各ステップで、担当エージェントとそのモデルを選びます。プロジェクトの実行プロファイルとタスクの種類で許可されたエージェントだけ選べます。</p>
    <div className="flowStepAgentGrid">
      {FLOW_STEP_DEFINITIONS.map((definition) => {
        const allowedAgents = agentsAllowedForFlowStep(definition.role, template.readOnly, profile, template);
        const agent = agents[definition.id];
        const modelOptions = modelsAllowedForAgent(agent);
        return <div key={definition.id} className="flowStepAgentRow">
          <span className="flowStepAgentRowLabel">{stepLabels[definition.id]}</span>
          <label>
            エージェント
            <select
              value={agent}
              disabled={disabled || allowedAgents.length === 0}
              onChange={(event) => changeAgent(definition.id, event.target.value as AgentId)}
            >
              {allowedAgents.map((item) => <option key={item} value={item}>{agentLabels[item]}</option>)}
            </select>
          </label>
          <label>
            モデル
            <select
              aria-label={`${stepLabels[definition.id]}のモデル`}
              value={models[definition.id]}
              disabled={disabled || modelOptions.length === 0}
              onChange={(event) => onModelsChange({ ...models, [definition.id]: event.target.value })}
            >
              {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        </div>;
      })}
    </div>
  </section>;
}
