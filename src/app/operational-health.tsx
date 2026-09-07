"use client";

import { useCallback, useEffect, useState } from "react";
import { humanMutationFetch } from "./human-mutation";

type Health = {
  status: "ready" | "degraded" | "unavailable";
  lifecycle: "RUNNING" | "DRAINING" | "STOPPED";
  database: { status: "ok"; schema: number; supportedMin: number; supportedMax: number };
  sandbox: string;
  providers: Record<string, { status: string; version?: string }>;
  backup: { lastVerifiedAgeHours: number | null; schemaVersion?: number; sizeBytes?: number };
  disk: { freeBytes: number; minimumFreeBytes: number; stateDbSize: number; backupSize: number; worktreeCreationAllowed: boolean };
  worktrees: { count: number; totalSizeBytes: number; orphaned: number };
  unfinishedOperations: number;
};
type Backup = { backupId: string; createdAt: string; schemaVersion: number; sizeBytes: number };

export function OperationalHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [latest, setLatest] = useState<Backup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [healthResponse, backupResponse] = await Promise.all([
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/state/backups", { cache: "no-store" }),
      ]);
      const data = await healthResponse.json() as Health & { errorCode?: string };
      const backupData = await backupResponse.json() as { backups?: Backup[] };
      if (!healthResponse.ok) throw new Error(data.errorCode || "Health check failed");
      if (!backupResponse.ok) throw new Error("Backup inventory failed");
      setHealth(data); setLatest(backupData.backups?.[0] ?? null); setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Health check failed"); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function backup() {
    setBusy(true); setError("");
    try {
      const response = await humanMutationFetch("/api/state/backups", "state-backup", { method: "POST" });
      const data = await response.json() as { backup?: Backup; error?: string };
      if (!response.ok || !data.backup) throw new Error(data.error || "Backup failed");
      setLatest(data.backup); await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Backup failed"); }
    finally { setBusy(false); }
  }

  async function validate() {
    if (!latest) return;
    setBusy(true); setError("");
    try {
      const response = await humanMutationFetch(`/api/state/backups/${latest.backupId}/validate`, "state-backup-validate", { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Backup validation failed");
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Backup validation failed"); }
    finally { setBusy(false); }
  }

  async function maintenance(enabled: boolean) {
    setBusy(true); setError("");
    try {
      const response = await humanMutationFetch("/api/maintenance", "maintenance-mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Maintenance mode update failed");
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Maintenance mode update failed"); }
    finally { setBusy(false); }
  }

  return <section className="credentialPanel" aria-labelledby="health-heading">
    <div><span className="eyebrow">Operational readiness</span><h2 id="health-heading">Health</h2></div>
    {health ? <>
      <div className="credentialGrid">
        <article><strong>Readiness</strong><span className="credentialState">{health.status}</span><small>Lifecycle: {health.lifecycle}</small></article>
        <article><strong>State database</strong><span className="credentialState">{health.database.status}</span><small>Schema {health.database.schema} · supported {health.database.supportedMin}–{health.database.supportedMax}</small></article>
        <article><strong>Backup</strong><span className="credentialState">{health.backup.lastVerifiedAgeHours === null ? "missing" : "verified"}</span><small>{health.backup.lastVerifiedAgeHours === null ? "No verified backup" : `${health.backup.lastVerifiedAgeHours}h old`}</small></article>
        <article><strong>Disk</strong><span className="credentialState">{health.disk.worktreeCreationAllowed ? "ok" : "low"}</span><small>{formatBytes(health.disk.freeBytes)} free · minimum {formatBytes(health.disk.minimumFreeBytes)}</small></article>
        <article><strong>Worktrees</strong><span className="credentialState">{health.worktrees.count}</span><small>{formatBytes(health.worktrees.totalSizeBytes)} · {health.worktrees.orphaned} need inspection</small></article>
        <article><strong>Operations</strong><span className="credentialState">{health.unfinishedOperations}</span><small>unfinished journal records</small></article>
        {Object.entries(health.providers).map(([name, provider]) => <article key={name}><strong>{name}</strong><span className="credentialState">{provider.status}</span><small>{provider.version || "Version unavailable"}</small></article>)}
      </div>
      <div className="dialogActions">
        <button type="button" disabled={busy || health.lifecycle !== "RUNNING"} onClick={() => void backup()}>Create verified backup</button>
        <button type="button" className="secondary" disabled={busy || !latest} onClick={() => void validate()}>Validate latest backup</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void maintenance(health.lifecycle === "RUNNING")}>{health.lifecycle === "RUNNING" ? "Enter maintenance" : "Leave maintenance"}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>Refresh health</button>
      </div>
    </> : <p className="muted">Checking operational readiness…</p>}
    {error ? <p className="error">{error}</p> : null}
    <p className="muted">Restore remains offline-only: <code>npm run state:restore -- &lt;backup-id&gt;</code>. Credentials are never included.</p>
  </section>;
}
function formatBytes(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`; }
