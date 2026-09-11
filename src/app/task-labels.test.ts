import { describe, expect, it } from "vitest";
import { attentionPresentation, flowStatusLabel, historyEventStatusLabel, prCheckStatusLabel, recoveryLabel, reviewDispositionLabel, statusBadgeLabel, taskBehaviorExplanation, taskBucketLabels, taskStatusFilterOptions, taskStatusLabel, validationStatusLabel, worktreeLabel } from "./task-labels";

const requiredBuckets = ["active", "needs_attention", "ready_for_approval", "pr_open", "ready_for_human_merge", "archived"] as const;
const requiredStatuses = ["draft", "reviewed", "awaiting_approval", "validating", "committing", "pushing", "creating_pr", "pr_created", "fetching_review", "review_ready", "awaiting_rework_approval", "reworking", "reviewing_rework", "awaiting_final_approval", "committing_rework", "pushing_rework", "checking_ci", "ready_for_human_merge", "review_fetch_failed", "rework_failed", "ci_failed", "ci_pending", "validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed", "push_failed", "pr_failed", "archived"];
const requiredRecoveryStates = ["recoverable", "needs_attention", "orphaned", "invalid"];
const requiredWorktreeStates = ["available", "not_required", "missing", "removed", "invalid"];

describe("task presentation labels", () => {
  it("maps every independently listed dashboard bucket, status, recovery, and worktree state", () => {
    for (const bucket of requiredBuckets) expect(taskBucketLabels[bucket]).toMatch(/[^\s]/);
    for (const status of requiredStatuses) expect(taskStatusLabel(status)).toMatch(/[^\s]/);
    for (const state of requiredRecoveryStates) expect(recoveryLabel(state)).toMatch(/[^\s]/);
    for (const state of requiredWorktreeStates) expect(worktreeLabel(state)).toMatch(/[^\s]/);
  });

  it("uses Japanese unknown fallbacks without leaking identifiers", () => {
    for (const value of ["FUTURE_STATUS", "future_recovery", "future_worktree"]) {
      const label = value === "FUTURE_STATUS" ? taskStatusLabel(value) : value.includes("recovery") ? recoveryLabel(value) : worktreeLabel(value);
      expect(label).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
      expect(label).not.toContain(value);
    }
  });

  it("maps History statuses without exposing unknown internal values", () => {
    expect(historyEventStatusLabel("validation_failed")).toBe("安全チェックで停止");
    expect(historyEventStatusLabel("future_history_state")).toBe("状態を確認してください");
    expect(historyEventStatusLabel("future_history_state")).not.toContain("future_history_state");
  });

  it("keeps validation, flow, PR-check, and review badges distinct from task lifecycle labels", () => {
    expect(["pass", "fail", "skip"].map(validationStatusLabel)).toEqual(["成功", "失敗", "スキップ"]);
    expect(["running", "completed", "error"].map(flowStatusLabel)).toEqual(["実行中", "完了", "エラー"]);
    expect(["pass", "fail", "pending"].map(prCheckStatusLabel)).toEqual(["成功", "失敗", "確認中"]);
    expect(["informational", "action_required", "blocking", "resolved"].map(reviewDispositionLabel)).toEqual(["参考情報", "対応が必要", "ブロック中", "解決済み"]);
    expect(statusBadgeLabel("validation", "pass")).toBe("成功");
    expect(statusBadgeLabel("flow", "running")).toBe("実行中");
    expect(statusBadgeLabel("pr_check", "pending")).toBe("確認中");
    expect(taskStatusLabel("pass")).toBe("状態を確認してください");
  });

  it("uses a safe Japanese fallback for each explicit badge domain", () => {
    const unknown = "future_badge_state";
    for (const domain of ["task", "validation", "flow", "pr_check", "review_disposition"] as const) {
      const label = statusBadgeLabel(domain, unknown);
      expect(label).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
      expect(label).not.toContain(unknown);
    }
  });

  it("keeps dashboard filter values internal while presenting Japanese labels", () => {
    const option = taskStatusFilterOptions().find((item) => item.value === "validation_failed");
    expect(option).toEqual({ value: "validation_failed", label: "安全チェックで停止" });
  });

  it("gives attention cards truthful explanations and only offers supported actions", () => {
    expect(attentionPresentation({ status: "commit_failed", bucket: "needs_attention", recoveryStatus: "needs_attention", worktreeStatus: "missing", canReassociate: true })).toMatchObject({ action: "reassociate", explanation: "以前の作業領域が見つかりません。復旧候補を確認できます。" });
    expect(attentionPresentation({ status: "commit_failed", bucket: "needs_attention", recoveryStatus: "orphaned", worktreeStatus: "available" })).toMatchObject({ action: "open", explanation: "作業領域との関連を確認する必要があります。詳細を確認してください。" });
    expect(attentionPresentation({ status: "commit_failed", bucket: "needs_attention", recoveryStatus: "invalid", recoveryMessage: "復旧前に履歴を確認してください。", worktreeStatus: "invalid" }).explanation).toContain("復旧前に履歴を確認してください。");
    expect(attentionPresentation({ status: "validation_failed", bucket: "needs_attention", recoveryStatus: "needs_attention", worktreeStatus: "available" }).explanation).toContain("安全チェック");
    expect(attentionPresentation({ status: "pr_failed", bucket: "needs_attention", recoveryStatus: "needs_attention", worktreeStatus: "available" }).explanation).toContain("PRの作成");
    expect(attentionPresentation({ status: "ci_failed", bucket: "needs_attention", recoveryStatus: "needs_attention", worktreeStatus: "available", canRefreshPr: true }).action).toBe("refresh_pr");
  });

  it("explains read-only and isolated write behavior without execution-mode jargon", () => {
    expect(taskBehaviorExplanation({ readOnly: true, requireWorktree: false, requireHumanApproval: false, requirePr: false })).toContain("変更しません");
    expect(taskBehaviorExplanation({ readOnly: false, requireWorktree: true, requireHumanApproval: true, requirePr: true })).toContain("隔離");
  });
});
