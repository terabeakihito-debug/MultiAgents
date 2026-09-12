import { describe, expect, it } from "vitest";
import type { FlowStep } from "../agents/types";
import { canRerunFailedReviewStep } from "./review-rerun";

const step = (id: FlowStep["id"], status: FlowStep["status"], output = ""): FlowStep => ({
  id,
  agent: id === "cursor_review" ? "cursor" : id === "claude_review" ? "claude" : "codex",
  role: id === "codex_draft" ? "draft" : id === "codex_final" ? "final" : "review",
  status,
  output,
});

describe("review rerun presentation", () => {
  it("offers rerun for every failed review step, including an output-free Codex draft failure", () => {
    expect(canRerunFailedReviewStep(step("codex_draft", "error"), true)).toBe(true);
  });

  it("offers rerun for output-free stale downstream steps", () => {
    expect(canRerunFailedReviewStep(step("cursor_review", "stale"), true)).toBe(true);
    expect(canRerunFailedReviewStep(step("claude_review", "stale"), true)).toBe(true);
    expect(canRerunFailedReviewStep(step("codex_final", "stale"), true)).toBe(true);
  });

  it("does not offer rerun for completed or active steps, or without a persisted task", () => {
    expect(canRerunFailedReviewStep(step("codex_draft", "completed", "draft"), true)).toBe(false);
    expect(canRerunFailedReviewStep(step("codex_draft", "running"), true)).toBe(false);
    expect(canRerunFailedReviewStep(step("codex_draft", "error"), false)).toBe(false);
  });
});
