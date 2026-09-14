import { describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../agents/types";
import { reviewStepActualBudgetMs, runReviewFlow } from "./review";

function completed(agent: AgentResult["agent"], output: string): AgentResult {
  return { agent, status: "completed", output };
}

describe("late-stage review reserve", () => {
  it("keeps enough Claude work time for the observed UI-shaped schedule", () => {
    const deadline = 300_000;
    expect(reviewStepActualBudgetMs("codex_draft", deadline, 0)).toBe(90_000);
    expect(reviewStepActualBudgetMs("cursor_review", deadline, 85_000)).toBe(90_000);
    expect(reviewStepActualBudgetMs("claude_review", deadline, 150_000)).toBe(80_000);
    expect(reviewStepActualBudgetMs("codex_final", deadline, 230_000)).toBe(40_000);
  });

  it("completes an end-to-end UI-shaped schedule inside the fixed 300s deadline", async () => {
    vi.useFakeTimers();
    try {
      const result = await runReviewFlow("request", {
        executeAgent: async (agent, _prompt, signal, stepId, onProviderWorkStart, onChildClose) => {
          const profile = {
            codex_draft: { preflight: 4_000, work: 78_000 },
            cursor_review: { preflight: 7_000, work: 56_000 },
            claude_review: { preflight: 4_000, work: 72_000 },
            codex_final: { preflight: 4_000, work: 29_000 },
          }[stepId];
          await vi.advanceTimersByTimeAsync(profile.preflight);
          const allowed = onProviderWorkStart?.();
          if (allowed === false) return { agent, status: "error", output: "", error: "rejected before provider work" };
          await vi.advanceTimersByTimeAsync(profile.work);
          if (signal.aborted) return { agent, status: "error", output: "", error: "aborted" };
          onChildClose?.();
          return completed(agent, `${stepId}-ok`);
        },
      });

      expect(result.status).toBe("completed");
      expect(result.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed", "completed"]);
      expect(result.steps.every((step) => step.terminationReason === undefined)).toBe(true);
      expect(result.steps.reduce((total, step) => total + (step.durationMs ?? 0), 0)).toBe(254_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
