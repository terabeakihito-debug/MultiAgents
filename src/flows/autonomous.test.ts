import { describe, expect, it, vi } from "vitest";
import type { FlowStep, ReviewFlowResult } from "../agents/types";
import { runAutonomousFlow } from "./autonomous";

const steps = (): FlowStep[] => [
  { id: "codex_draft", agent: "codex", role: "draft", status: "completed", output: "draft" },
  { id: "cursor_review", agent: "cursor", role: "review", status: "completed", output: "cursor" },
  { id: "claude_review", agent: "claude", role: "review", status: "completed", output: "claude" },
  { id: "codex_final", agent: "codex", role: "final", status: "completed", output: "final" },
];

function successfulResult(flowId: string): ReviewFlowResult {
  return { flowId, status: "completed", steps: steps(), finalOutput: "final" };
}

describe("autonomous review flow", () => {
  it("validates a successful review once", async () => {
    const validate = vi.fn(async () => undefined);
    const runReview = vi.fn(async () => successfulResult("flow-1"));

    await expect(runAutonomousFlow("Fix the bug", { runReview, validate })).resolves.toMatchObject({ status: "completed" });
    expect(runReview).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledWith(1);
  });

  it("runs one bounded repair iteration after validation failure", async () => {
    const validate = vi.fn()
      .mockRejectedValueOnce(new Error("npm test failed"))
      .mockResolvedValueOnce(undefined);
    const prompts: string[] = [];
    const runReview = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return successfulResult(`flow-${prompts.length}`);
    });
    const resetForRepair = vi.fn();

    await expect(runAutonomousFlow("Fix the bug", { runReview, validate, resetForRepair })).resolves.toMatchObject({ status: "completed", flowId: "flow-2" });
    expect(runReview).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("npm test failed");
    expect(resetForRepair).toHaveBeenCalledWith(expect.stringContaining("npm test failed"), 1);
  });

  it("stops after the maximum number of attempts", async () => {
    const validate = vi.fn(async () => { throw new Error("still failing"); });
    const runReview = vi.fn(async () => successfulResult(`flow-${runReview.mock.calls.length + 1}`));
    const events: string[] = [];

    const result = await runAutonomousFlow("Fix the bug", {
      runReview,
      validate,
      onEvent: (event) => { if ("result" in event) events.push(event.result.status); },
    });

    expect(result.status).toBe("error");
    expect(runReview).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toBe("error");
  });
});
