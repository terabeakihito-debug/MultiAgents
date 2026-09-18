"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { defaultNotificationPreferences, notificationTypes, type AppNotification, type NotificationPreferences, type NotificationSeverity, type NotificationType } from "@/notifications/types";
import { defaultOutboundChannelConfig, type OutboundChannelConfig } from "@/outbound/types";
import { humanMutationFetch } from "./human-mutation";
import type { HumanMutationAction } from "@/security/human-actions";

type Repo = { id: string; name: string };
type Props = { repos: Repo[]; refreshToken: number; onOpenTask: (taskId: string) => void; onError: (message: string) => void };

const browserBodies: Record<NotificationType, string> = {
  finding_critical_created: "重大な運用項目の確認が必要です。", finding_high_created: "優先度の高い運用項目の確認が必要です。",
  task_needs_attention: "対応が必要なタスクがあります。", task_ready_for_approval: "承認できるタスクがあります。",
  pr_changes_requested: "プルリクエストに修正依頼があります。", ci_failed: "必要な検証に失敗しました。",
  pr_ready_for_human_merge: "人がマージできるプルリクエストがあります。", task_inactive: "タスクが停止しています。",
  worktree_orphaned: "管理対象の作業領域を確認してください。", approval_invalidated: "タスクの承認が無効になりました。",
};

export function NotificationCenter({ repos, refreshToken, onOpenTask, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [severity, setSeverity] = useState<NotificationSeverity | "">("");
  const [repo, setRepo] = useState("");
  const [type, setType] = useState<NotificationType | "">("");
  const [preferences, setPreferences] = useState<NotificationPreferences>(defaultNotificationPreferences);
  const [outboundConfig, setOutboundConfig] = useState<OutboundChannelConfig>(defaultOutboundChannelConfig);
  const [slackConfigured, setSlackConfigured] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [notice, setNotice] = useState("");
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const initialized = useRef(false);
  const seen = useRef(new Set<string>());

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: "100", unreadOnly: String(unreadOnly) });
    if (severity) query.set("severity", severity);
    if (repo) query.set("repo", repo);
    if (type) query.set("type", type);
    const response = await fetch(`/api/notifications?${query}`);
    const data = await response.json() as { notifications?: AppNotification[]; unreadCount?: number; error?: string };
    if (!response.ok || !data.notifications) throw new Error(data.error || "Could not load notifications");
    if (initialized.current && browserEnabled && Notification.permission === "granted") {
      for (const item of data.notifications.filter((value) => value.status === "unread" && !seen.current.has(value.notificationId))) {
        new Notification("MultiAgents", { body: browserBodies[item.type] });
      }
    }
    data.notifications.forEach((item) => seen.current.add(item.notificationId));
    initialized.current = true;
    setNotifications(data.notifications); setUnreadCount(data.unreadCount ?? 0);
  }, [browserEnabled, repo, severity, type, unreadOnly]);

  useEffect(() => {
    const timer = window.setTimeout(() => setBrowserEnabled("Notification" in window && window.localStorage.getItem("multiagents-browser-notifications") === "enabled" && Notification.permission === "granted"), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load().catch((error: unknown) => onError(error instanceof Error ? error.message : "Could not load notifications")), 0);
    const refreshTimer = window.setInterval(() => void load().catch(() => undefined), 30_000);
    return () => { window.clearTimeout(initialTimer); window.clearInterval(refreshTimer); };
  }, [load, onError, refreshToken]);
  useEffect(() => {
    if (!open) return;
    void Promise.all([
      fetch("/api/notification-preferences").then(async (response) => {
        const data = await response.json() as { preferences?: NotificationPreferences; error?: string };
        if (!response.ok || !data.preferences) throw new Error(data.error || "Could not load notification preferences");
        setPreferences(data.preferences);
      }),
      fetch("/api/outbound/slack/settings").then(async (response) => {
        const data = await response.json() as { configured?: boolean; config?: OutboundChannelConfig; error?: string };
        if (!response.ok || !data.config || typeof data.configured !== "boolean") throw new Error(data.error || "Could not load Slack settings");
        setOutboundConfig(data.config); setSlackConfigured(data.configured);
      }),
    ]).catch((error: unknown) => onError(error instanceof Error ? error.message : "Could not load notification settings"));
  }, [onError, open]);

  async function mutate(path: string, action: HumanMutationAction) {
    const response = await humanMutationFetch(path, action, { method: "POST" });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error || "Notification update failed");
    await load(); setNotice("通知を更新しました。");
  }

  async function savePreferences(next: NotificationPreferences) {
    setPreferences(next); setNotice("通知設定を保存しました。");
    const response = await humanMutationFetch("/api/notification-preferences", "notification-preferences", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
    });
    const data = await response.json() as { preferences?: NotificationPreferences; error?: string };
    if (!response.ok || !data.preferences) throw new Error(data.error || "Could not save notification preferences");
  }

  async function saveOutboundConfig(next: OutboundChannelConfig) {
    setOutboundConfig(next); setNotice("外部通知設定を保存しました。");
    const response = await humanMutationFetch("/api/outbound/slack/settings", "outbound-preferences", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
    });
    const data = await response.json() as { configured?: boolean; config?: OutboundChannelConfig; error?: string };
    if (!response.ok || !data.config || typeof data.configured !== "boolean") throw new Error(data.error || "Could not save Slack settings");
    setOutboundConfig(data.config); setSlackConfigured(data.configured);
  }

  async function sendSlackTest() {
    setSendingTest(true);
    try {
      const response = await humanMutationFetch("/api/outbound/slack/test", "outbound-test", { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Slack test delivery failed");
      setNotice("テスト通知を送信しました。");
    } finally { setSendingTest(false); }
  }

  async function enableBrowserNotifications() {
    if (!("Notification" in window)) { onError("このブラウザは通知に対応していません。"); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { onError("ブラウザ通知が許可されませんでした。"); return; }
    window.localStorage.setItem("multiagents-browser-notifications", "enabled");
    setBrowserEnabled(true);
    setNotice("ブラウザ通知を有効にしました。"); new Notification("MultiAgents", { body: "ブラウザ通知を有効にしました。" });
  }

  return <div className="notificationRoot">
    <button type="button" className="notificationBell" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)} aria-label={`未読通知 ${unreadCount}件`}>通知 <strong>{unreadCount}</strong></button>
    {open ? <section className="notificationPanel" role="dialog" aria-label="通知">
      <div className="notificationHeading"><div><span className="eyebrow">運用通知</span><h2>通知</h2><p>未読 {unreadCount}件</p></div><button type="button" className="secondary compactButton" onClick={() => void mutate("/api/notifications/read-all", "notification-read-all").catch((error: unknown) => onError(message(error)))}>すべて既読にする</button></div>
      {notice ? <p className="actionResult actionResult-success" role="status">{notice}</p> : null}
      <div className="notificationFilters">
        <label><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} /> 未読だけ</label>
        <label>重大度<select value={severity} onChange={(event) => setSeverity(event.target.value as NotificationSeverity | "")}><option value="">すべて</option>{(["critical", "high", "warning", "info"] as const).map((value) => <option key={value} value={value}>{notificationSeverityLabel(value)}</option>)}</select></label>
        <label>リポジトリ<select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">すべて</option>{repos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>種類<select value={type} onChange={(event) => setType(event.target.value as NotificationType | "")}><option value="">すべて</option>{notificationTypes.map((value) => <option key={value} value={value}>{notificationTypeLabel(value)}</option>)}</select></label>
      </div>
      {notifications.length > 20 ? <p className="muted">最新20件だけ表示しています。重大度・リポジトリ・種類で絞り込めます。</p> : null}
      <div className="notificationList">{notifications.length ? notifications.slice(0, 20).map((item) => {
        const slack = item.deliveries?.find((delivery) => delivery.channel === "slack");
        return <article key={item.notificationId} className={`notificationItem ${item.status} severity-${item.severity}`}>
          <div><span className={`severityBadge ${item.severity}`}>{notificationSeverityLabel(item.severity)}</span><time>{relativeTime(item.createdAt)}</time></div><h3>{notificationTitle(item)}</h3><p>{notificationMessage(item)}</p><small>{item.repoName || item.repoId || "ローカル操作"}{item.prNumber ? ` · PR #${item.prNumber}` : ""}</small>
          {slack ? <p className={`deliveryStatus delivery-${slack.status}`}>Slack: {deliveryLabel(slack.status, slack.errorCode)}</p> : null}
          <div className="notificationActions">{item.taskId ? <button type="button" className="compactButton" onClick={() => { setOpen(false); onOpenTask(item.taskId!); }}>関連タスクを開く</button> : null}{item.status === "unread" ? <button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/read`, "notification-read").catch((error: unknown) => onError(message(error)))}>既読にする</button> : null}<button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/dismiss`, "notification-dismiss").catch((error: unknown) => onError(message(error)))}>通知を閉じる</button>{slack && ["failed", "ambiguous"].includes(slack.status) ? <button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/deliveries/slack/retry`, "outbound-retry").catch((error: unknown) => onError(message(error)))}>Slackを再送</button> : null}{slack?.status === "ambiguous" ? <><button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/deliveries/slack/mark-delivered`, "outbound-mark-delivered").catch((error: unknown) => onError(message(error)))}>Slack送信済みにする</button><button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/deliveries/slack/dismiss`, "outbound-dismiss").catch((error: unknown) => onError(message(error)))}>Slack送信を閉じる</button></> : null}</div>
        </article>;
      }) : <p className="muted">この条件に一致する通知はありません。</p>}</div>
      <details className="notificationSettings"><summary>通知設定</summary>
        <div className="preferenceGrid">{(Object.keys(defaultNotificationPreferences) as Array<keyof NotificationPreferences>).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => void savePreferences({ ...preferences, [key]: event.target.checked }).catch((error: unknown) => onError(message(error)))} /> {preferenceLabel(key)}</label>)}</div>
        <button type="button" className="secondary" disabled={browserEnabled} onClick={() => void enableBrowserNotifications()}>{browserEnabled ? "ブラウザ通知は有効です" : "ブラウザ通知を有効にする"}</button>
        <p className="muted">ブラウザ通知には一般的な運用情報だけを表示します。許可を求めるのはこのボタンを押したときだけです。</p>
        <section className="externalNotificationSettings" aria-label="外部通知">
          <h3>外部通知</h3>
          <div className="externalStatus"><strong>Slack</strong><span>状態: {slackConfigured ? "設定済み" : "未設定"}</span></div>
          <label><input type="checkbox" checked={outboundConfig.enabled} onChange={(event) => void saveOutboundConfig({ ...outboundConfig, enabled: event.target.checked }).catch((error: unknown) => onError(message(error)))} /> 有効</label>
          <label>チャンネル名<input value={outboundConfig.channelLabel} maxLength={80} onChange={(event) => setOutboundConfig({ ...outboundConfig, channelLabel: event.target.value })} onBlur={() => void saveOutboundConfig(outboundConfig).catch((error: unknown) => onError(message(error)))} /></label>
          <div className="preferenceGrid">{outboundPreferenceFields.map(([key, label]) => <label key={key}><input type="checkbox" checked={outboundConfig[key]} onChange={(event) => void saveOutboundConfig({ ...outboundConfig, [key]: event.target.checked }).catch((error: unknown) => onError(message(error)))} /> {label}</label>)}</div>
          <button type="button" className="secondary" disabled={!slackConfigured || sendingTest} onClick={() => void sendSlackTest().catch((error: unknown) => onError(message(error)))}>{sendingTest ? "送信中…" : "テスト通知を送信"}</button>
          <p className="muted">Webhook URLはサーバー環境からのみ取得し、表示・保存しません。判定不能な送信結果は自動再送しません。</p>
        </section>
      </details>
    </section> : null}
  </div>;
}

function relativeTime(value: string) { const elapsed = Date.now() - Date.parse(value); if (elapsed < 60_000) return "たった今"; if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分前`; if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}時間前`; return `${Math.floor(elapsed / 86_400_000)}日前`; }
const notificationSeverityLabels: Record<NotificationSeverity, string> = { critical: "重大", high: "高", warning: "注意", info: "情報" };
const notificationTypeLabels: Record<NotificationType, string> = {
  finding_critical_created: "重大な指摘", finding_high_created: "高優先度の指摘", task_needs_attention: "対応が必要なタスク",
  task_ready_for_approval: "承認待ちのタスク", pr_changes_requested: "PRの修正依頼", ci_failed: "CI失敗",
  pr_ready_for_human_merge: "人のマージ待ち", task_inactive: "停止タスク", worktree_orphaned: "孤立した作業領域",
  approval_invalidated: "承認のやり直しが必要",
};
const notificationMessages: Record<NotificationType, string> = {
  finding_critical_created: "重大な指摘が作成されました。", finding_high_created: "高優先度の指摘が作成されました。",
  task_needs_attention: "タスクが対応必要になりました。", task_ready_for_approval: "タスクが担当者の承認待ちです。",
  pr_changes_requested: "プルリクエストに修正依頼があります。", ci_failed: "CIが失敗しました。",
  pr_ready_for_human_merge: "プルリクエストが人によるマージ待ちです。", task_inactive: "タスクが停止しています。",
  worktree_orphaned: "作業領域の確認が必要です。", approval_invalidated: "変更内容が変わったため、担当者の承認が必要です。",
};
function notificationSeverityLabel(value: NotificationSeverity) { return notificationSeverityLabels[value]; }
function notificationTypeLabel(value: NotificationType) { return notificationTypeLabels[value]; }
function notificationTitle(item: AppNotification) { return notificationTypeLabels[item.type] || item.title; }
function notificationMessage(item: AppNotification) { return notificationMessages[item.type] || item.message; }
function preferenceLabel(value: keyof NotificationPreferences) { return value.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()).replace("Critical", "重大").replace("High", "高").replace("Findings", "な指摘").replace("Needs Attention", "対応が必要").replace("Changes Requested", "修正依頼").replace("Ci Failed", "CI失敗").replace("Ready For Human Merge", "人のマージ待ち").replace("Ready For Approval", "承認待ち").replace("Inactive Task", "停止タスク").replace("Worktree Orphaned", "孤立作業領域").replace("Approval Invalidated", "承認無効"); }
const outboundPreferenceFields: Array<[Exclude<keyof OutboundChannelConfig, "channel" | "enabled" | "channelLabel">, string]> = [
  ["sendCriticalFindings", "重大な指摘"], ["sendHighFindings", "高優先度の指摘"], ["sendNeedsAttention", "対応が必要"],
  ["sendChangesRequested", "修正依頼"], ["sendCiFailed", "CI失敗"], ["sendReadyForHumanMerge", "人のマージ待ち"],
  ["sendReadyForApproval", "承認待ち"], ["sendInactiveTask", "停止タスク"], ["sendWorktreeOrphaned", "孤立作業領域"],
  ["sendApprovalInvalidated", "承認無効"],
];
function deliveryLabel(status: string, errorCode?: string) { if (status === "suppressed" && errorCode === "not_configured") return "未設定"; return status === "failed" ? "失敗" : status === "ambiguous" ? "判定不能" : status === "delivered" ? "送信済み" : status === "pending" ? "送信待ち" : status; }
function message(error: unknown) { return error instanceof Error ? error.message : "通知操作に失敗しました。"; }
