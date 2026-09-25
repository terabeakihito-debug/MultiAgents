import { describe, expect, it } from "vitest";
import { mergeTemplateWithProfile, builtInTemplate } from "../templates/policy";
import { safeDefaultSnapshot } from "../profiles/policy";
import { agentsAllowedForFlowStep, defaultFlowStepAgents, parseFlowStepAgentPlan } from "./step-agents";

describe("flow step agents", () => {
  const repoId = "Demo";
  const profile = safeDefaultSnapshot(repoId);
  const template = mergeTemplateWithProfile(builtInTemplate(repoId, "bug_fix"), profile);

  it("defaults to the built-in review flow agents", () => {
    expect(defaultFlowStepAgents()).toEqual({
      codex_draft: "codex",
      cursor_review: "cursor",
      claude_review: "claude",
      codex_final: "codex",
    });
  });

  it("allows swapping review agents when roles permit", () => {
    expect(parseFlowStepAgentPlan({
      cursor_review: "claude",
      claude_review: "cursor",
    }, profile, template).cursor_review).toBe("claude");
  });

  it("rejects implement-only steps assigned to review-only agents", () => {
    expect(() => parseFlowStepAgentPlan({ codex_draft: "cursor" }, profile, template)).toThrow(/cannot run codex_draft/);
  });

  it("offers review-only agents for read-only templates", () => {
    const readOnly = mergeTemplateWithProfile(builtInTemplate(repoId, "investigation"), profile);
    expect(agentsAllowedForFlowStep("draft", true, profile, readOnly)).toEqual(["codex", "cursor", "claude"]);
    expect(parseFlowStepAgentPlan({ codex_draft: "claude" }, profile, readOnly).codex_draft).toBe("claude");
  });
});
