"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { defaultNotificationPreferences, notificationTypes, type AppNotification, type NotificationPreferences, type NotificationSeverity, type NotificationType } from "@/notifications/types";

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
    void fetch("/api/notification-preferences").then(async (response) => {
      const data = await response.json() as { preferences?: NotificationPreferences; error?: string };
      if (!response.ok || !data.preferences) throw new Error(data.error || "Could not load notification preferences");
      setPreferences(data.preferences);
    }).catch((error: unknown) => onError(error instanceof Error ? error.message : "Could not load notification preferences"));
  }, [onError, open]);

  async function mutate(path: string, action: string) {
    const response = await fetch(path, { method: "POST", headers: { "X-MultiAgents-Human-Action": action } });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error || "Notification update failed");
    await load();
  }

  async function savePreferences(next: NotificationPreferences) {
    setPreferences(next);
    const response = await fetch("/api/notification-preferences", {
      method: "POST", headers: { "Content-Type": "application/json", "X-MultiAgents-Human-Action": "notification-preferences" }, body: JSON.stringify(next),
    });
    const data = await response.json() as { preferences?: NotificationPreferences; error?: string };
    if (!response.ok || !data.preferences) throw new Error(data.error || "Could not save notification preferences");
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
      <div className="notificationList">{notifications.length ? notifications.map((item) => <article key={item.notificationId} className={`notificationItem ${item.status} severity-${item.severity}`}>
        <div><span className={`severityBadge ${item.severity}`}>{item.severity}</span><time>{relativeTime(item.createdAt)}</time></div><h3>{item.title}</h3><p>{item.message}</p><small>{item.repoName || item.repoId || "Local operation"}{item.prNumber ? ` · PR #${item.prNumber}` : ""}</small>
        <div className="notificationActions">{item.taskId ? <button type="button" className="compactButton" onClick={() => { setOpen(false); onOpenTask(item.taskId!); }}>Open related</button> : null}{item.status === "unread" ? <button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/read`, "notification-read").catch((error: unknown) => onError(message(error)))}>Mark as read</button> : null}<button type="button" className="secondary compactButton" onClick={() => void mutate(`/api/notifications/${item.notificationId}/dismiss`, "notification-dismiss").catch((error: unknown) => onError(message(error)))}>Dismiss</button></div>
      </article>) : <p className="muted">No notifications match these filters.</p>}</div>
      <details className="notificationSettings"><summary>Notification settings</summary>
        <div className="preferenceGrid">{(Object.keys(defaultNotificationPreferences) as Array<keyof NotificationPreferences>).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => void savePreferences({ ...preferences, [key]: event.target.checked }).catch((error: unknown) => onError(message(error)))} /> {preferenceLabel(key)}</label>)}</div>
        <button type="button" className="secondary" disabled={browserEnabled} onClick={() => void enableBrowserNotifications()}>{browserEnabled ? "Browser notifications enabled" : "Enable browser notifications"}</button>
        <p className="muted">Browser alerts contain only generic operational text. Permission is requested only by this button.</p>
      </details>
    </section> : null}
  </div>;
}

function relativeTime(value: string) { const elapsed = Date.now() - Date.parse(value); if (elapsed < 60_000) return "just now"; if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`; if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`; return `${Math.floor(elapsed / 86_400_000)}d ago`; }
function preferenceLabel(value: keyof NotificationPreferences) { return value.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()); }
function message(error: unknown) { return error instanceof Error ? error.message : "Notification action failed"; }
