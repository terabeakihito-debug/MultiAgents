import { describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../agents/types";
import { runReviewFlow } from "./review";

function completed(agent: AgentResult["agent"], output: string): AgentResult {
  return { agent, status: "completed", output };
}

describe("review provider-work budget boundary", () => {
  it("does not charge ordinary preflight time against the provider work budget", async () => {
    vi.useFakeTimers();
    try {
      const result = await runReviewFlow("request", {
        executeAgent: async (agent, _prompt, signal, stepId, onProviderWorkStart, onChildClose) => {
          if (stepId === "codex_draft") {
            await vi.advanceTimersByTimeAsync(10_000);
            onProviderWorkStart?.();
            await vi.advanceTimersByTimeAsync(85_000);
            if (signal.aborted) return { agent, status: "error", output: "", error: "aborted" };
            onChildClose?.();
            return completed(agent, "draft");
          }
          onProviderWorkStart?.();
          onChildClose?.();
          return completed(agent, `${stepId}-ok`);
        },
      });

      expect(result.status).toBe("completed");
      expect(result.steps[0]).toMatchObject({ status: "completed", durationMs: 95_000 });
      expect(result.steps.every((step) => step.terminationReason === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows an approximately 92s draft when provider work remains under the 90s work cap", async () => {
    vi.useFakeTimers();
    try {
      const result = await runReviewFlow("request", {
        executeAgent: async (agent, _prompt, signal, stepId, onProviderWorkStart, onChildClose) => {
          if (stepId === "codex_draft") {
            await vi.advanceTimersByTimeAsync(3_000);
            onProviderWorkStart?.();
            await vi.advanceTimersByTimeAsync(89_000);
            if (signal.aborted) return { agent, status: "error", output: "", error: "aborted" };
            onChildClose?.();
            return completed(agent, "draft");
          }
          onProviderWorkStart?.();
          onChildClose?.();
          return completed(agent, `${stepId}-ok`);
        },
      });

      expect(result.status).toBe("completed");
      expect(result.steps[0]).toMatchObject({ status: "completed", durationMs: 92_000 });
      expect(result.steps[0].terminationReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recomputes available work time at the provider boundary after slow preflight", async () => {
    vi.useFakeTimers();
    try {
      const result = await runReviewFlow("request", {
        executeAgent: async (agent, _prompt, signal, stepId, onProviderWorkStart) => {
          if (stepId !== "codex_draft") return completed(agent, "unused");
          await vi.advanceTimersByTimeAsync(20_000);
          onProviderWorkStart?.();
          await vi.advanceTimersByTimeAsync(86_000);
          return signal.aborted
            ? { agent, status: "error", output: "", error: "aborted" }
            : completed(agent, "unexpected");
        },
      });

      expect(result.status).toBe("error");
      expect(result.steps[0]).toMatchObject({
        status: "error",
        terminationReason: "step_budget_exhausted",
        error: "Review step budget exhausted.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
