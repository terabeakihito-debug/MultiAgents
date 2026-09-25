import { describe, expect, it } from "vitest";
import { defaultFlowStepAgents } from "./step-agents";
import { defaultFlowStepModels, defaultModelForAgent, parseFlowStepModelPlan } from "./agent-models";

describe("agent-models", () => {
  it("defaults models from the agent plan", () => {
    const agents = defaultFlowStepAgents();
    expect(defaultFlowStepModels(agents)).toEqual({
      codex_draft: defaultModelForAgent("codex"),
      cursor_review: defaultModelForAgent("cursor"),
      claude_review: defaultModelForAgent("claude"),
      codex_final: defaultModelForAgent("codex"),
    });
  });

  it("accepts per-step overrides", () => {
    const agents = defaultFlowStepAgents();
    expect(parseFlowStepModelPlan({ cursor_review: "gpt-5.6-sol" }, agents).cursor_review).toBe("gpt-5.6-sol");
  });

  it("rejects models that do not belong to the step agent", () => {
    const agents = defaultFlowStepAgents();
    expect(() => parseFlowStepModelPlan({ cursor_review: "claude-sonnet-4.5" }, agents)).toThrow(/not allowed/);
  });
});
