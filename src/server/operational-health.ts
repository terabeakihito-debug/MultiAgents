import { lstat, opendir, statfs } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { WorktreeUsage } from "../health/types";
import { APP_STATE_COMPAT, getStateStore, type StateStore } from "./state-store";
import { checkOsSandboxAvailability } from "./os-sandbox";
import { providerDiagnostics } from "./provider-diagnostics";
import { latestVerifiedBackup } from "./state-backup";
import { lifecycleState } from "./operation-registry";
import { listTasks, WORKTREE_ROOT } from "./tasks";
import { runGit } from "./git";

export const MINIMUM_WORKTREE_FREE_BYTES = 2 * 1024 * 1024 * 1024;

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
