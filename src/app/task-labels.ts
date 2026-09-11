import type { TaskBucket } from "../dashboard/types";

export const taskBucketLabels: Record<TaskBucket, string> = {
  active: "進行中",
  needs_attention: "対応が必要",
  ready_for_approval: "確認・承認待ち",
  pr_open: "PR確認中",
  ready_for_human_merge: "マージ確認待ち",
  archived: "完了・アーカイブ",
};

export const taskStatusLabels = {
  draft: "準備中", reviewed: "確認済み", awaiting_approval: "変更の確認待ち", validating: "安全チェック中",
  committing: "変更を保存中", pushing: "GitHubへ送信中", creating_pr: "PRを作成中", pr_created: "PR作成済み",
  fetching_review: "レビュー結果を取得中", review_ready: "レビュー結果あり", awaiting_rework_approval: "修正の確認待ち",
  reworking: "修正中", reviewing_rework: "修正内容をレビュー中", awaiting_final_approval: "最終確認待ち",
  committing_rework: "修正を保存中", pushing_rework: "修正をGitHubへ送信中", checking_ci: "CI確認中",
  ready_for_human_merge: "人によるマージ確認待ち", review_fetch_failed: "レビュー結果の取得に失敗",
  rework_failed: "修正作業で停止", ci_failed: "CIで停止", ci_pending: "CI実行中",
  validation_failed: "安全チェックで停止", secret_scan_failed: "機密情報の可能性を検出",
  approval_invalidated: "変更されたため再確認が必要", commit_failed: "変更の保存に失敗",
  push_failed: "GitHubへの送信に失敗", pr_failed: "PR作成に失敗", archived: "アーカイブ済み",
} as const;

export const taskStatusValues = Object.keys(taskStatusLabels) as Array<keyof typeof taskStatusLabels>;

export function taskStatusFilterOptions() {
  return taskStatusValues.map((value) => ({ value, label: taskStatusLabel(value) }));
}

export const recoveryLabels: Record<string, string> = {
  recoverable: "復旧できます",
  needs_attention: "確認が必要です",
  orphaned: "作業領域との関連を確認してください",
  invalid: "安全に利用できない状態です",
};

export const worktreeLabels: Record<string, string> = {
  available: "作業領域を利用できます", not_required: "作業領域は不要です", missing: "作業領域が見つかりません",
  removed: "作業領域は削除済みです", invalid: "作業領域を安全に利用できません",
};

export function taskStatusLabel(status: string) {
  return taskStatusLabels[status as keyof typeof taskStatusLabels] ?? "状態を確認してください";
}

export function historyEventStatusLabel(status: string | undefined) {
  return status ? taskStatusLabel(status) : "";
}

const validationStatusLabels: Record<string, string> = { pass: "成功", fail: "失敗", skip: "スキップ" };
const flowStatusLabels: Record<string, string> = {
  idle: "待機中", running: "実行中", completed: "完了", error: "エラー", skipped: "スキップ", stale: "再確認が必要",
  aborted: "中断", timed_out: "時間切れ",
};
const prCheckStatusLabels: Record<string, string> = { pass: "成功", fail: "失敗", pending: "確認中", skipping: "対象外", unknown: "状態不明" };
const reviewDispositionLabels: Record<string, string> = { informational: "参考情報", action_required: "対応が必要", blocking: "ブロック中", resolved: "解決済み" };
const findingSeverityLabels: Record<string, string> = { critical: "重大", high: "高", medium: "中", low: "低", info: "情報" };

export function validationStatusLabel(status: string) {
  return validationStatusLabels[status] ?? "結果を確認してください";
}

export function flowStatusLabel(status: string) {
  return flowStatusLabels[status] ?? "実行状態を確認してください";
}

export function prCheckStatusLabel(status: string) {
  return prCheckStatusLabels[status] ?? "チェック状態を確認してください";
}

export function reviewDispositionLabel(status: string) {
  return reviewDispositionLabels[status] ?? "レビュー状態を確認してください";
}

export function findingSeverityLabel(status: string) {
  return findingSeverityLabels[status] ?? "重要度を確認してください";
}

export type StatusBadgeDomain = "task" | "validation" | "flow" | "pr_check" | "review_disposition" | "finding_severity";

export function statusBadgeLabel(domain: StatusBadgeDomain, status: string) {
  switch (domain) {
    case "task": return taskStatusLabel(status);
    case "validation": return validationStatusLabel(status);
    case "flow": return flowStatusLabel(status);
    case "pr_check": return prCheckStatusLabel(status);
    case "review_disposition": return reviewDispositionLabel(status);
    case "finding_severity": return findingSeverityLabel(status);
  }
}

export function recoveryLabel(status: string) {
  return recoveryLabels[status] ?? "状態を確認してください";
}

export function worktreeLabel(status: string) {
  return worktreeLabels[status] ?? "作業領域の状態を確認してください";
}

export function taskBehaviorExplanation(template: { readOnly: boolean; requireWorktree: boolean; requireHumanApproval: boolean; requirePr: boolean } | undefined) {
  if (!template) return "タスクの種類を選択してください。";
  if (template.readOnly) return "このタスクはリポジトリを変更しません。";
  if (template.requireWorktree && template.requireHumanApproval && template.requirePr) return "変更は隔離された作業領域で行われ、確認なしにマージされません。";
  if (template.requireWorktree) return "変更は隔離された作業領域で行われます。";
  return "このタスクは設定済みの安全な手順で進められます。";
}

export type AttentionPresentation = {
  label: string;
  explanation: string;
  action: "reassociate" | "open" | "refresh_pr" | "none";
};

export function attentionPresentation(task: {
  status: string;
  bucket: string;
  recoveryStatus: string;
  recoveryMessage?: string;
  worktreeStatus: string;
  canReassociate?: boolean;
  canRefreshPr?: boolean;
}): AttentionPresentation {
  if (task.worktreeStatus === "missing") {
    return task.canReassociate
      ? { label: "作業領域が見つかりません", explanation: "以前の作業領域が見つかりません。復旧候補を確認できます。", action: "reassociate" }
      : { label: "作業領域が見つかりません", explanation: "以前の作業領域が見つかりません。詳細を確認してください。", action: "open" };
  }
  if (task.recoveryStatus === "orphaned") return { label: "作業領域との関連を確認してください", explanation: "作業領域との関連を確認する必要があります。詳細を確認してください。", action: "open" };
  if (task.recoveryStatus === "invalid" || task.worktreeStatus === "invalid") {
    return { label: "安全に再開できない状態です", explanation: task.recoveryMessage ? `安全に再開できない状態です。${task.recoveryMessage}` : "安全に再開できない状態です。詳細を確認してください。", action: "open" };
  }
  if (task.status === "validation_failed" || task.status === "secret_scan_failed") return { label: taskStatusLabel(task.status), explanation: "安全チェックで停止しました。詳細を確認してから次の操作を選んでください。", action: "open" };
  if (task.status === "ci_failed") return { label: "CIで停止", explanation: "CIの確認で停止しました。PRと詳細を確認してください。", action: task.canRefreshPr ? "refresh_pr" : "open" };
  if (task.status === "pr_failed") return { label: "PR作成に失敗", explanation: "PRの作成で停止しました。詳細を確認してから再試行してください。", action: "open" };
  if (task.bucket === "ready_for_approval") return { label: taskBucketLabels.ready_for_approval, explanation: "変更内容を確認して、次の手順を選んでください。", action: "open" };
  if (task.status === "pr_created") return { label: "PR作成済み", explanation: "PRを作成しました。内容を確認してください。", action: "open" };
  return { label: taskStatusLabel(task.status), explanation: "タスクを開いて次の操作を確認してください。", action: "open" };
}
