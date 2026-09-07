import { lstat, opendir, statfs } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { WorktreeUsage } from "../health/types";
import { APP_STATE_COMPAT, getStateStore, type StateStore } from "./state-store";
import { checkOsSandboxAvailability } from "./os-sandbox";
import { providerDiagnostics } from "./provider-diagnostics";
import { latestVerifiedBackup } from "./state-backup";
import { activeOperations, lifecycleState } from "./operation-registry";
import { listTasks, WORKTREE_ROOT } from "./tasks";
import { runGit } from "./git";

export const MINIMUM_WORKTREE_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const BACKUP_FRESH_HOURS = 24;
export const BACKUP_ATTENTION_HOURS = 72;
export const DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
const execFile = promisify(execFileCallback);
let sandboxVersionCache: { value: string; expiresAt: number } | undefined;

export type OperationsOverall = "ready" | "attention" | "critical";
export type OperationsLevel = "ok" | "warning" | "attention" | "critical";

/** A local-only, path-free view for the Operations UI.  This never contacts GitHub or Slack. */
export async function operationsOverview(options: { forceProviders?: boolean; now?: Date; worktreeRoot?: string } = {}) {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  let store: StateStore;
  let database: { status: "ok"; schema: number; supportedMin: number; supportedMax: number; sizeBytes: number; checkedAt: string } | { status: "failed"; checkedAt: string };
  try {
    store = getStateStore();
    const ready = databaseReadiness(store);
    let sizeBytes = 0;
    try { sizeBytes = (await lstat(store.path)).size; } catch { /* in-memory test stores have no file */ }
    database = { ...ready, sizeBytes, checkedAt };
  } catch {
    return unavailableOverview(checkedAt);
  }

  const [sandboxResult, sandboxVersion, providers, disk, inventory] = await Promise.all([
    checkOsSandboxAvailability().then(() => ({ status: "enforced" as const })).catch(() => ({ status: "unavailable" as const })),
    bubblewrapVersion(),
    providerDiagnostics({ force: options.forceProviders }),
    diskUsage(options.worktreeRoot),
    inspectWorktrees(options.worktreeRoot),
  ]);
  const backups = store.loadBackups();
  const latest = latestVerifiedBackup(store, now);
  const backupLevel = backupStatus(latest?.ageHours ?? null);
  const diskLevel: OperationsLevel = disk.freeBytes < MINIMUM_WORKTREE_FREE_BYTES ? "attention" : disk.freeBytes < DISK_WARNING_BYTES ? "warning" : "ok";
  const unfinished = store.loadUnfinishedOperations();
  const reconcile = unfinished.filter((item) => item.state === "reconcile_required");
  const notificationPage = store.queryNotifications({ limit: 100, unreadOnly: false });
  const deliveries = notificationPage.notifications.flatMap((item) => (item.deliveries ?? []).map((delivery) => ({ ...delivery, notificationId: item.notificationId, taskId: item.taskId, title: item.title })));
  const outbound = {
    unread: notificationPage.unreadCount,
    failed: deliveries.filter((item) => item.status === "failed").length,
    ambiguous: deliveries.filter((item) => item.status === "ambiguous").length,
    pending: deliveries.filter((item) => item.status === "pending").length,
    deliveredRecent: deliveries.filter((item) => item.status === "delivered" && item.deliveredAt && Date.parse(item.deliveredAt) >= now.getTime() - 86_400_000).length,
    lastNotificationAt: notificationPage.notifications[0]?.createdAt,
    attention: deliveries.filter((item) => item.status === "failed" || item.status === "ambiguous").map((item) => ({ notificationId: item.notificationId, taskId: item.taskId, title: item.title, status: item.status })),
  };
  const providersView = providers.map((provider) => ({ ...provider, level: provider.status === "supported" ? "ok" as const : "attention" as const }));
  const worktrees = inventory.map((item) => ({ ...item, classification: item.cleanupCandidate ? "safe_cleanup_candidate" : item.inventoryStatus === "registered" ? "registered" : "needs_inspection" }));
  const upgradeReady = lifecycleState() === "RUNNING" && activeOperations().length === 0 && backupLevel === "ok" && diskLevel === "ok" && database.status === "ok" && sandboxResult.status === "enforced" && providersView.every((item) => item.level === "ok") && unfinished.length === 0;
  const issueCodes: string[] = [];
  if (sandboxResult.status !== "enforced") issueCodes.push("sandbox_unavailable");
  if (providersView.some((item) => item.level !== "ok")) issueCodes.push("provider_unavailable");
  if (backupLevel === "attention") issueCodes.push("backup_attention");
  if (diskLevel === "attention") issueCodes.push("disk_low");
  if (worktrees.some((item) => item.inventoryStatus !== "registered")) issueCodes.push("worktree_inventory");
  if (reconcile.length) issueCodes.push("reconcile_required");
  if (outbound.failed || outbound.ambiguous) issueCodes.push("outbound_attention");
  const overall: OperationsOverall = issueCodes.includes("sandbox_unavailable") ? "critical" : issueCodes.length ? "attention" : "ready";
  return {
    checkedAt, overall, nextAction: nextActionFor(issueCodes), database,
    backup: { level: backupLevel, latest: latest ? { backupId: latest.backupId, createdAt: latest.createdAt, ageHours: Number(latest.ageHours.toFixed(2)), schemaVersion: latest.schemaVersion, sizeBytes: latest.sizeBytes, integrity: latest.integrityStatus } : null, count: backups.length, items: backups.map((item) => ({ backupId: item.backupId, createdAt: item.createdAt, schemaVersion: item.schemaVersion, sizeBytes: item.sizeBytes, integrity: item.integrityStatus })) },
    disk: { ...disk, level: diskLevel },
    sandbox: { ...sandboxResult, backend: "bubblewrap", version: sandboxVersion, privateHome: true, privateProc: true, privateTmp: true, validationNetwork: "blocked", wslInterop: "blocked" },
    providers: providersView,
    maintenance: { state: lifecycleState(), activeCount: activeOperations().length },
    activeOperations: activeOperations(),
    unfinishedOperations: unfinished.map((item) => ({ operationId: item.operationId, type: item.type, taskId: item.taskId, findingId: item.findingId, notificationId: item.notificationId, state: item.state, createdAt: item.createdAt, updatedAt: item.updatedAt, errorCode: item.errorCode })),
    reconcileRequired: reconcile.length,
    worktrees: { count: worktrees.length, totalSizeBytes: worktrees.reduce((sum, item) => sum + item.sizeBytes, 0), orphaned: worktrees.filter((item) => item.inventoryStatus !== "registered").length, cleanupCandidates: worktrees.filter((item) => item.cleanupCandidate).length, inventory: worktrees },
    outbound,
    upgrade: { ready: upgradeReady, reason: upgradeReady ? "Ready for manual upgrade" : "Resolve Operations attention items before manual upgrade" },
  };
}

export function backupStatus(ageHours: number | null): OperationsLevel {
  if (ageHours === null || ageHours > BACKUP_ATTENTION_HOURS) return "attention";
  if (ageHours >= BACKUP_FRESH_HOURS) return "warning";
  return "ok";
}

function unavailableOverview(checkedAt: string) {
  return { checkedAt, overall: "critical" as const, nextAction: "Inspect database readiness", database: { status: "failed" as const, checkedAt }, backup: { level: "attention" as const, latest: null, count: 0, items: [] }, disk: { freeBytes: 0, minimumFreeBytes: MINIMUM_WORKTREE_FREE_BYTES, stateDbSize: 0, backupSize: 0, worktreeCreationAllowed: false, level: "attention" as const }, sandbox: { status: "unavailable" as const, backend: "bubblewrap", version: "unavailable", privateHome: true, privateProc: true, privateTmp: true, validationNetwork: "blocked", wslInterop: "blocked" }, providers: [], maintenance: { state: lifecycleState(), activeCount: activeOperations().length }, activeOperations: activeOperations(), unfinishedOperations: [], reconcileRequired: 0, worktrees: { count: 0, totalSizeBytes: 0, orphaned: 0, cleanupCandidates: 0, inventory: [] }, outbound: { unread: 0, failed: 0, ambiguous: 0, pending: 0, deliveredRecent: 0, attention: [] }, upgrade: { ready: false, reason: "Database readiness must be restored" } };
}

function nextActionFor(issues: string[]) {
  if (issues.includes("sandbox_unavailable")) return "Repair sandbox availability";
  if (issues.includes("provider_unavailable")) return "Refresh or reauthenticate provider diagnostics";
  if (issues.includes("backup_attention")) return "Create a verified backup";
  if (issues.includes("disk_low")) return "Free disk space before creating worktrees";
  if (issues.includes("reconcile_required")) return "Review reconciliation-required operations";
  if (issues.includes("worktree_inventory")) return "Inspect orphaned or missing worktrees";
  if (issues.includes("outbound_attention")) return "Review Slack delivery outcomes";
  return "No action required";
}

async function bubblewrapVersion() {
  if (sandboxVersionCache && sandboxVersionCache.expiresAt > Date.now()) return sandboxVersionCache.value;
  let value = "unavailable";
  try {
    const result = await execFile("/usr/bin/bwrap", ["--version"], { timeout: 2_000, maxBuffer: 1_000 });
    value = result.stdout.trim().replace(/^bubblewrap\s+/i, "").slice(0, 40) || "available";
  } catch { /* availability check remains the authority for enforcement */ }
  sandboxVersionCache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

export function databaseReadiness(store: StateStore = getStateStore()) {
  const schema = store.schemaVersion();
  if (schema < APP_STATE_COMPAT.minSchema || schema > APP_STATE_COMPAT.maxSchema) throw new ReadinessError("state_schema_incompatible");
  if (store.integrityCheck() !== "ok") throw new ReadinessError("state_integrity_failed");
  return { status: "ok" as const, schema, supportedMin: APP_STATE_COMPAT.minSchema, supportedMax: APP_STATE_COMPAT.maxSchema };
}

export async function healthReadiness(options: { providerCwd?: string; forceProviders?: boolean } = {}) {
  const store = getStateStore();
  const database = databaseReadiness(store);
  const [sandbox, providers, disk, worktrees] = await Promise.all([
    checkOsSandboxAvailability().then(() => "enforced" as const).catch(() => "unavailable" as const),
    providerDiagnostics({ cwd: options.providerCwd, force: options.forceProviders }),
    diskUsage(),
    inspectWorktrees(),
  ]);
  const backup = latestVerifiedBackup(store);
  const status = sandbox === "enforced" && providers.every((provider) => provider.status === "supported")
    && Boolean(backup) && disk.worktreeCreationAllowed && store.loadUnfinishedOperations().length === 0 ? "ready" : "degraded";
  return {
    status,
    lifecycle: lifecycleState(),
    database,
    sandbox,
    providers: Object.fromEntries(providers.map((provider) => [provider.provider, { status: provider.status, version: provider.version }])),
    backup: backup ? { lastVerifiedAgeHours: Number(backup.ageHours.toFixed(2)), schemaVersion: backup.schemaVersion, sizeBytes: backup.sizeBytes } : { lastVerifiedAgeHours: null },
    disk,
    worktrees: {
      count: worktrees.length,
      totalSizeBytes: worktrees.reduce((sum, item) => sum + item.sizeBytes, 0),
      orphaned: worktrees.filter((item) => item.inventoryStatus !== "registered").length,
      inventory: worktrees,
    },
    unfinishedOperations: store.loadUnfinishedOperations().length,
  };
}

export async function diskUsage(root = WORKTREE_ROOT) {
  const existing = await nearestExisting(root);
  const info = await statfs(existing);
  const freeBytes = Number(info.bavail) * Number(info.bsize);
  let stateDbSize = 0; let backupSize = 0;
  try { stateDbSize = (await lstat(getStateStore().path)).size; } catch { /* unavailable is reported by DB readiness */ }
  for (const backup of getStateStore().loadBackups()) backupSize += backup.sizeBytes;
  return { freeBytes, minimumFreeBytes: MINIMUM_WORKTREE_FREE_BYTES, stateDbSize, backupSize, worktreeCreationAllowed: freeBytes >= MINIMUM_WORKTREE_FREE_BYTES };
}

export async function assertWorktreeDiskCapacity(options: { root?: string; freeBytes?: number } = {}) {
  const freeBytes = options.freeBytes ?? (await diskUsage(options.root)).freeBytes;
  if (freeBytes < MINIMUM_WORKTREE_FREE_BYTES) throw new ReadinessError("insufficient_disk_space");
  return freeBytes;
}

export async function inspectWorktrees(root = WORKTREE_ROOT): Promise<WorktreeUsage[]> {
  const tasks = listTasks();
  const entries = await inspectTaskWorktrees(tasks);
  const registeredPaths = await registeredWorktreePaths(tasks);
  for (const path of await filesystemWorktreeDirectories(root)) {
    if (tasks.some((task) => task.worktreePath === path)) continue;
    const rel = relative(root, path).split(sep);
    entries.push({ repoId: rel[0] || "unknown", ageHours: 0, sizeBytes: await directorySize(path), inventoryStatus: registeredPaths.has(path) ? "unregistered_git_worktree" : "orphaned_filesystem", cleanupCandidate: false });
  }
  return entries;
}

export async function inspectTaskWorktrees(tasks = listTasks()): Promise<WorktreeUsage[]> {
  const registeredPaths = await registeredWorktreePaths(tasks);
  const entries: WorktreeUsage[] = [];
  for (const task of tasks.filter((item) => item.worktreeStatus !== "not_required" && item.worktreeStatus !== "removed")) {
    let info;
    try { info = await lstat(task.worktreePath); }
    catch {
      entries.push({ taskId: task.id, repoId: task.repoId, ageHours: ageHours(task.updatedAt), sizeBytes: 0, taskStatus: task.status, prState: task.prReview?.state, inventoryStatus: "missing_filesystem", cleanupCandidate: false });
      continue;
    }
    const sizeBytes = info.isDirectory() && !info.isSymbolicLink() ? await directorySize(task.worktreePath) : 0;
    let dirty: boolean | undefined;
    try { dirty = Boolean(await runGit(task.worktreePath, ["status", "--porcelain"])); } catch { dirty = undefined; }
    const registered = registeredPaths.has(task.worktreePath);
    entries.push({
      taskId: task.id, repoId: task.repoId, ageHours: ageHours(task.updatedAt), sizeBytes, taskStatus: task.status,
      dirty, prState: task.prReview?.state, inventoryStatus: registered ? "registered" : "orphaned_filesystem",
      cleanupCandidate: registered && dirty === false && (task.status === "archived" || task.prReview?.state === "CLOSED" || task.prReview?.merged === true),
    });
  }
  return entries;
}

async function registeredWorktreePaths(tasks: ReturnType<typeof listTasks>) {
  const registeredPaths = new Set<string>();
  for (const repoPath of new Set(tasks.map((task) => task.repoPath))) {
    try {
      const lines = (await runGit(repoPath, ["worktree", "list", "--porcelain"])).split("\n");
      for (const line of lines) if (line.startsWith("worktree ")) registeredPaths.add(line.slice(9));
    } catch { /* represented through task recovery */ }
  }
  return registeredPaths;
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) { try { total += (await lstat(path)).size; } catch { /* concurrent cleanup */ } }
  }
  return total;
}

async function filesystemWorktreeDirectories(root: string) {
  const result: string[] = [];
  let repos;
  try { repos = await opendir(root); } catch { return result; }
  for await (const repo of repos) {
    if (!repo.isDirectory()) continue;
    const repoPath = join(root, repo.name);
    const tasks = await opendir(repoPath);
    for await (const task of tasks) if (task.isDirectory()) result.push(join(repoPath, task.name));
  }
  return result;
}
async function nearestExisting(path: string): Promise<string> {
  try { await lstat(path); return path; }
  catch { const parent = dirname(path); if (parent === path) throw new ReadinessError("disk_path_unavailable"); return nearestExisting(parent); }
}
function ageHours(value: string) { return Math.max(0, (Date.now() - Date.parse(value)) / 3_600_000); }
export class ReadinessError extends Error {}
