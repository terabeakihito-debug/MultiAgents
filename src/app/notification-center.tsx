"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { defaultNotificationPreferences, notificationTypes, type AppNotification, type NotificationPreferences, type NotificationSeverity, type NotificationType } from "@/notifications/types";
import { defaultOutboundChannelConfig, type OutboundChannelConfig } from "@/outbound/types";
import { humanMutationFetch } from "./human-mutation";
import type { HumanMutationAction } from "@/security/human-actions";

type Repo = { id: string; name: string };
type Props = { repos: Repo[]; refreshToken: number; onOpenTask: (taskId: string) => void; onError: (message: string) => void };

const browserBodies: Record<NotificationType, string> = {
  finding_critical_created: "A critical operational item requires review.", finding_high_created: "A high-priority operational item requires review.",
  task_needs_attention: "A task needs attention.", task_ready_for_approval: "A task is ready for approval.",
  pr_changes_requested: "A pull request needs reviewed changes.", ci_failed: "Required checks failed.",
  pr_ready_for_human_merge: "A pull request is ready for human merge.", task_inactive: "A task has become inactive.",
  worktree_orphaned: "A managed worktree needs attention.", approval_invalidated: "A task approval was invalidated.",
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
    await load();
  }

  async function savePreferences(next: NotificationPreferences) {
    setPreferences(next);
    const response = await humanMutationFetch("/api/notification-preferences", "notification-preferences", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
    });
    const data = await response.json() as { preferences?: NotificationPreferences; error?: string };
    if (!response.ok || !data.preferences) throw new Error(data.error || "Could not save notification preferences");
  }

  async function saveOutboundConfig(next: OutboundChannelConfig) {
    setOutboundConfig(next);
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
    } finally { setSendingTest(false); }
  }

  async function enableBrowserNotifications() {
    if (!("Notification" in window)) { onError("Browser notifications are not supported by this browser"); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { onError("Browser notification permission was not granted"); return; }
    window.localStorage.setItem("multiagents-browser-notifications", "enabled");
    setBrowserEnabled(true);
    new Notification("MultiAgents", { body: "Browser notifications are enabled." });
  }

  return <div className="notificationRoot">
    <button type="button" className="notificationBell" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)} aria-label={`${unreadCount} unread notifications`}>🔔 <strong>{unreadCount}</strong></button>
    {open ? <section className="notificationPanel" role="dialog" aria-label="Notifications">
      <div className="notificationHeading"><div><span className="eyebrow">Operational alerts</span><h2>Notifications</h2><p>Unread {unreadCount}</p></div><button type="button" className="secondary compactButton" onClick={() => void mutate("/api/notifications/read-all", "notification-read-all").catch((error: unknown) => onError(message(error)))}>Mark all as read</button></div>
      <div className="notificationFilters">
        <label><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} /> Unread only</label>
        <label>Severity<select value={severity} onChange={(event) => setSeverity(event.target.value as NotificationSeverity | "")}><option value="">All</option>{(["critical", "high", "warning", "info"] as const).map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Repository<select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">All</option>{repos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Type<select value={type} onChange={(event) => setType(event.target.value as NotificationType | "")}><option value="">All</option>{notificationTypes.map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <div className="notificationList">{notifications.length ? notifications.map((item) => {
        const slack = item.deliveries?.find((delivery) => delivery.channel === "slack");
        return <article key={item.notificationId} className={`notificationItem ${item.status} severity-${item.severity}`}>
          <div><span className={`severityBadge ${item.severity}`}>{item.severity}</span><time>{relativeTime(item.createdAt)}</time></div><h3>{item.title}</h3><p>{item.message}</p><small>{item.repoName || item.repoId || "Local operation"}{item.prNumber ? ` · PR #${item.prNumber}` : ""}</small>
          {slack ? <p className={`deliveryStatus delivery-${slack.status}`}>Slack: {deliveryLabel(slack.status, slack.errorCode)}</p> : null}
          <div className="notificationActions">{item.taskId ? <button type="button" className="compactButton" onClick={() => { setOpen(false); onOpenTask(item.taskId!); }}>Open related</button> : null}{item.status === "unread" ? <button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/read`, "notification-read").catch((error: unknown) => onError(message(error)))}>Mark as read</button> : null}<button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/dismiss`, "notification-dismiss").catch((error: unknown) => onError(message(error)))}>Dismiss</button>{slack && ["failed", "ambiguous"].includes(slack.status) ? <button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/deliveries/slack/retry`, "outbound-retry").catch((error: unknown) => onError(message(error)))}>Retry Slack</button> : null}{slack?.status === "ambiguous" ? <><button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/deliveries/slack/mark-delivered`, "outbound-mark-delivered").catch((error: unknown) => onError(message(error)))}>Mark Slack delivered</button><button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/deliveries/slack/dismiss`, "outbound-dismiss").catch((error: unknown) => onError(message(error)))}>Dismiss Slack attempt</button></> : null}</div>
        </article>;
      }) : <p className="muted">No notifications match these filters.</p>}</div>
      <details className="notificationSettings"><summary>Notification settings</summary>
        <div className="preferenceGrid">{(Object.keys(defaultNotificationPreferences) as Array<keyof NotificationPreferences>).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => void savePreferences({ ...preferences, [key]: event.target.checked }).catch((error: unknown) => onError(message(error)))} /> {preferenceLabel(key)}</label>)}</div>
        <button type="button" className="secondary" disabled={browserEnabled} onClick={() => void enableBrowserNotifications()}>{browserEnabled ? "Browser notifications enabled" : "Enable browser notifications"}</button>
        <p className="muted">Browser alerts contain only generic operational text. Permission is requested only by this button.</p>
        <section className="externalNotificationSettings" aria-label="External Notifications">
          <h3>External Notifications</h3>
          <div className="externalStatus"><strong>Slack</strong><span>Status: {slackConfigured ? "configured" : "not configured"}</span></div>
          <label><input type="checkbox" checked={outboundConfig.enabled} onChange={(event) => void saveOutboundConfig({ ...outboundConfig, enabled: event.target.checked }).catch((error: unknown) => onError(message(error)))} /> Enabled</label>
          <label>Channel label<input value={outboundConfig.channelLabel} maxLength={80} onChange={(event) => setOutboundConfig({ ...outboundConfig, channelLabel: event.target.value })} onBlur={() => void saveOutboundConfig(outboundConfig).catch((error: unknown) => onError(message(error)))} /></label>
          <div className="preferenceGrid">{outboundPreferenceFields.map(([key, label]) => <label key={key}><input type="checkbox" checked={outboundConfig[key]} onChange={(event) => void saveOutboundConfig({ ...outboundConfig, [key]: event.target.checked }).catch((error: unknown) => onError(message(error)))} /> {label}</label>)}</div>
          <button type="button" className="secondary" disabled={!slackConfigured || sendingTest} onClick={() => void sendSlackTest().catch((error: unknown) => onError(message(error)))}>{sendingTest ? "Sending…" : "Send test notification"}</button>
          <p className="muted">The webhook URL comes only from the server environment and is never displayed or stored. Ambiguous delivery outcomes are never retried automatically.</p>
        </section>
      </details>
    </section> : null}
  </div>;
}

function relativeTime(value: string) { const elapsed = Date.now() - Date.parse(value); if (elapsed < 60_000) return "just now"; if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`; if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`; return `${Math.floor(elapsed / 86_400_000)}d ago`; }
function preferenceLabel(value: keyof NotificationPreferences) { return value.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()); }
const outboundPreferenceFields: Array<[Exclude<keyof OutboundChannelConfig, "channel" | "enabled" | "channelLabel">, string]> = [
  ["sendCriticalFindings", "Critical Findings"], ["sendHighFindings", "High Findings"], ["sendNeedsAttention", "Needs Attention"],
  ["sendChangesRequested", "Changes Requested"], ["sendCiFailed", "CI Failed"], ["sendReadyForHumanMerge", "Ready for Merge"],
  ["sendReadyForApproval", "Ready for Approval"], ["sendInactiveTask", "Inactive Task"], ["sendWorktreeOrphaned", "Worktree Orphaned"],
  ["sendApprovalInvalidated", "Approval Invalidated"],
];
function deliveryLabel(status: string, errorCode?: string) { if (status === "suppressed" && errorCode === "not_configured") return "Not configured"; return status.charAt(0).toUpperCase() + status.slice(1); }
function message(error: unknown) { return error instanceof Error ? error.message : "Notification action failed"; }
