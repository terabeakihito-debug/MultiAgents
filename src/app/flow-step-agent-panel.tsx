"use client";

import { flowStepIds, type AgentId } from "@/agents/types";
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
  value,
  disabled,
  onChange,
}: {
  profile: ProjectProfileSnapshot;
  template: TaskTemplateSnapshot;
  value: FlowStepAgentPlan;
  disabled?: boolean;
  onChange: (plan: FlowStepAgentPlan) => void;
}) {
  return <section className="flowStepAgentPanel" aria-labelledby="flow-step-agents-title">
    <div className="profileHeading">
      <div>
        <span className="eyebrow">実行</span>
        <h3 id="flow-step-agents-title">ステップごとの担当エージェント</h3>
      </div>
      <button type="button" className="secondary compactButton" disabled={disabled} onClick={() => onChange(defaultFlowStepAgents())}>既定に戻す</button>
    </div>
    <p className="muted">レビュー方式の各ステップで、どのエージェントが実行するかを選びます。プロジェクトの実行プロファイルとタスクの種類で許可されたエージェントだけ選べます。</p>
    <div className="flowStepAgentGrid">
      {FLOW_STEP_DEFINITIONS.map((definition) => {
        const allowed = agentsAllowedForFlowStep(definition.role, template.readOnly, profile, template);
        return <label key={definition.id}>
          {stepLabels[definition.id]}
          <select
            value={value[definition.id]}
            disabled={disabled || allowed.length === 0}
            onChange={(event) => onChange({ ...value, [definition.id]: event.target.value as AgentId })}
          >
            {allowed.map((agent) => <option key={agent} value={agent}>{agentLabels[agent]}</option>)}
          </select>
        </label>;
      })}
    </div>
  </section>;
}
