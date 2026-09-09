import { lstat, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { CleanupCandidate, CleanupCandidateType, RetentionPreset } from "../operations/types";
import { activeOperations, beginRegisteredOperation, hasActiveTaskOperation } from "./operation-registry";
import { BACKUP_DIRECTORY, deleteStateBackup, validateStateBackup } from "./state-backup";
import { getStateStore, type StateStore } from "./state-store";
import { deleteTask, listTasks, type RepoTask } from "./tasks";
import { runGit } from "./git";
import { acquireTaskLock, releaseTaskLock } from "./task-lock";

const DAY = 86_400_000;
const KEEP_VERIFIED_BACKUPS = 3;
export const retentionThresholds = {
  conservative: { worktree: 30, read: 90, dismissed: 30, outbound: 90, backup: 30 },
  balanced: { worktree: 14, read: 60, dismissed: 14, outbound: 60, backup: 14 },
} as const;

export type CleanupSummary = { candidates: CleanupCandidate[]; potentialSavingsBytes: number; blocked: number; preset: RetentionPreset };
type EvaluationOptions = { store?: StateStore; now?: Date; tasks?: RepoTask[]; backupDirectory?: string };

export async function evaluateCleanupCandidates(options: EvaluationOptions = {}): Promise<CleanupSummary> {
  const store = options.store ?? getStateStore();
  const now = options.now ?? new Date();
  const preset = store.loadRetentionPolicy();
  const tasks = options.tasks ?? listTasks();
  const candidates = [
    ...await Promise.all(tasks.filter((task) => task.worktreeAvailable && task.worktreeStatus === "available").map((task) => worktreeCandidate(task, preset, now, store))),
    ...await Promise.all(tasks.filter((task) => task.worktreeAvailable && task.worktreeStatus === "available").map((task) => nodeModulesCandidate(task, now, store))),
    ...await backupCandidates(store, preset, now, options.backupDirectory),
    ...notificationCandidates(store, preset, now),
  ].filter((item): item is CleanupCandidate => Boolean(item));
  return { candidates, potentialSavingsBytes: candidates.filter((item) => item.safeToDelete).reduce((sum, item) => sum + item.estimatedBytes, 0), blocked: candidates.filter((item) => !item.safeToDelete && item.recommendedAction === "review").length, preset };
}

async function worktreeCandidate(task: RepoTask, preset: RetentionPreset, now: Date, store: StateStore): Promise<CleanupCandidate> {
  const identity = await inspectWorktree(task);
  const reasons = taskBlockers(task, store, true);
  reasons.push(...identity.reasons);
  const ageDays = age(task.updatedAt, now);
  if (ageDays < retentionThresholds[preset].worktree) reasons.push(`Archived worktree is newer than the ${retentionThresholds[preset].worktree}-day retention threshold.`);
  return candidate(`worktree:${task.id}`, "worktree", task, ageDays, identity.bytes, reasons);
}

async function nodeModulesCandidate(task: RepoTask, now: Date, store: StateStore): Promise<CleanupCandidate | undefined> {
  const identity = await inspectWorktree(task);
  if (identity.reasons.length) return undefined; // no path-derived candidate for an untrusted worktree
  const target = join(identity.root!, "node_modules");
  let info;
  try { info = await lstat(target); } catch { return undefined; }
  const reasons = taskBlockers(task, store, false);
  if (!info.isDirectory() || info.isSymbolicLink()) reasons.push("node_modules must be a regular directory, never a symlink.");
  try {
    const resolved = await realpath(target);
    const rel = relative(identity.root!, resolved);
    if (rel !== "node_modules" || rel.startsWith(`..${sep}`)) reasons.push("node_modules is outside the managed task worktree.");
  } catch { reasons.push("node_modules identity could not be verified."); }
  return candidate(`worktree_node_modules:${task.id}`, "worktree_node_modules", task, age(task.updatedAt, now), info.isDirectory() && !info.isSymbolicLink() ? await directorySize(target) : 0, reasons);
}

async function backupCandidates(store: StateStore, preset: RetentionPreset, now: Date, directory = BACKUP_DIRECTORY) {
  const backups = store.loadBackups();
  return Promise.all(backups.map(async (backup, index) => {
    const reasons: string[] = [];
    const ageDays = age(backup.createdAt, now);
    if (index < KEEP_VERIFIED_BACKUPS) reasons.push(`Latest ${KEEP_VERIFIED_BACKUPS} verified backups are always retained.`);
    if (ageDays < retentionThresholds[preset].backup) reasons.push(`Backup is newer than the ${retentionThresholds[preset].backup}-day retention threshold.`);
    if (activeOperations().length || store.loadUnfinishedOperations().length) reasons.push("A maintenance or recovery operation is active.");
    try { validateStateBackup(backup.backupId, { store, directory }); } catch { reasons.push("Backup integrity or file identity could not be verified."); }
    return candidate(`backup:${backup.backupId}`, "backup", undefined, ageDays, backup.sizeBytes, reasons);
  }));
}

function notificationCandidates(store: StateStore, preset: RetentionPreset, now: Date): CleanupCandidate[] {
  const result: CleanupCandidate[] = [];
  for (const item of store.loadNotificationsForRetention()) {
    const timestamp = item.status === "dismissed" ? item.dismissedAt : item.readAt;
    if (item.status === "unread" || !timestamp) continue;
    const reasons = notificationBlockers(item, store);
    const ageDays = age(timestamp, now);
    const threshold = item.status === "dismissed" ? retentionThresholds[preset].dismissed : retentionThresholds[preset].read;
    if (ageDays < threshold) reasons.push(`Notification is newer than the ${threshold}-day retention threshold.`);
    result.push(candidate(`notification:${item.notificationId}`, "notification", undefined, ageDays, 0, reasons));
    const delivery = item.deliveries?.find((value) => value.channel === "slack");
    if (delivery?.status === "delivered" && delivery.deliveredAt) {
      const deliveryReasons = [...notificationBlockers(item, store)];
      const deliveryAge = age(delivery.deliveredAt, now);
      if (deliveryAge < retentionThresholds[preset].outbound) deliveryReasons.push(`Delivery is newer than the ${retentionThresholds[preset].outbound}-day retention threshold.`);
      result.push(candidate(`outbound_delivery:${item.notificationId}`, "outbound_delivery", undefined, deliveryAge, 0, deliveryReasons));
    }
  }
  return result;
}

function notificationBlockers(item: import("../notifications/types").AppNotification, store: StateStore) {
  const reasons: string[] = [];
  if (item.status === "unread") reasons.push("Unread notifications are retained.");
  if (item.severity === "critical") reasons.push("Critical unresolved linkage requires manual review.");
  if (item.findingId && store.loadFinding(item.findingId)?.status !== "dismissed" && !store.loadFinding(item.findingId)?.resolvedAt) reasons.push("Unresolved finding linkage is retained.");
  if (item.taskId) {
    const task = listTasks().find((value) => value.id === item.taskId);
    if (task && (task.status === "ready_for_human_merge" || task.status !== "archived")) reasons.push("Attention-required task linkage is retained.");
  }
  return reasons;
}

function taskBlockers(task: RepoTask, store: StateStore, requireArchived: boolean) {
  const reasons: string[] = [];
  const explicitlyCandidate = task.prReview?.state === "CLOSED" || task.prReview?.merged === true;
  if (requireArchived && task.status !== "archived" && !explicitlyCandidate) reasons.push("Worktree cleanup requires an archived task or an explicitly closed PR cleanup candidate.");
  if (task.status !== "archived" && (task.flowStatus === "running" || ["validating", "committing", "pushing", "creating_pr", "fetching_review", "reworking", "checking_ci"].includes(task.status))) reasons.push("Running task or validation requires manual review.");
  if (task.status === "ready_for_human_merge") reasons.push("Ready-for-human-merge worktrees are retained.");
  if (task.prNumber && (!task.prReview || task.prReview.state === "OPEN" || !task.prReview.merged)) reasons.push("Open PR worktrees are retained.");
  if (task.recoveryStatus !== "recoverable") reasons.push("Reconciliation-required worktree is retained.");
  if (hasActiveTaskOperation(task.id) || store.loadUnfinishedOperations().some((operation) => operation.taskId === task.id)) reasons.push("An active or reconciliation-required operation targets this task.");
  return reasons;
}

async function inspectWorktree(task: RepoTask) {
  const reasons: string[] = [];
  let info; try { info = await lstat(task.worktreePath); } catch { return { reasons: ["Managed worktree is missing."], bytes: 0, root: undefined as string | undefined }; }
  if (!info.isDirectory() || info.isSymbolicLink()) reasons.push("Managed worktree must be a regular directory, never a symlink.");
  let root: string | undefined;
  try {
    root = await realpath(task.worktreeRoot);
    const target = await realpath(task.worktreePath);
    const expected = join(root, task.repoId, task.id);
    if (target !== expected || relative(root, target).startsWith(`..${sep}`)) reasons.push("Managed worktree identity does not match its registered task.");
    const registered = (await runGit(task.repoPath, ["worktree", "list", "--porcelain"])).split("\n").includes(`worktree ${target}`);
    if (!registered) reasons.push("Managed worktree is not registered with Git.");
    if (await runGit(target, ["status", "--porcelain"])) reasons.push("Dirty worktree requires manual review.");
    root = target;
  } catch { reasons.push("Managed worktree identity could not be verified."); }
  return { reasons, bytes: info.isDirectory() && !info.isSymbolicLink() ? await directorySize(task.worktreePath) : 0, root };
}

function candidate(candidateId: string, type: CleanupCandidateType, task: RepoTask | undefined, ageDays: number, estimatedBytes: number, reasons: string[]): CleanupCandidate {
  const safeToDelete = reasons.length === 0;
  return { candidateId, type, repoId: task?.repoId, taskId: task?.id, ageDays: Math.floor(ageDays), estimatedBytes, safeToDelete, blockedReasons: reasons, recommendedAction: safeToDelete ? "delete" : reasons.some((reason) => /threshold|requires an archived/.test(reason)) ? "keep" : "review" };
}
function age(value: string, now: Date) { return Math.max(0, (now.getTime() - Date.parse(value)) / DAY); }
async function directorySize(root: string): Promise<number> { let total = 0; const { opendir } = await import("node:fs/promises"); const directory = await opendir(root); for await (const entry of directory) { const path = join(root, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) total += await directorySize(path); else if (entry.isFile()) { try { total += (await lstat(path)).size; } catch { /* concurrent change: execute will revalidate */ } } } return total; }

export async function previewCleanup(candidateIds: string[], options: EvaluationOptions = {}) {
  const summary = await evaluateCleanupCandidates(options);
  const selected = select(summary, candidateIds);
  (options.store ?? getStateStore()).appendCleanupAudit("cleanup_preview_created", { count: selected.length, reclaimBytes: selected.reduce((sum, item) => sum + item.estimatedBytes, 0) });
  return { ...summary, selected, estimatedBytes: selected.reduce((sum, item) => sum + item.estimatedBytes, 0) };
}

export async function executeCleanup(candidateIds: string[], options: EvaluationOptions = {}) {
  const store = options.store ?? getStateStore();
  if (await cleanupPostconditionsAlreadySatisfied(candidateIds, store)) {
    return { completed: [...candidateIds], estimatedBytes: 0, idempotent: true };
  }
  const summary = await evaluateCleanupCandidates({ ...options, store });
  let selected: CleanupCandidate[];
  try { selected = select(summary, candidateIds); } catch (error) { store.appendCleanupAudit("cleanup_blocked", { count: candidateIds.length }); throw error; }
  if (selected.some((item) => !item.safeToDelete)) { store.appendCleanupAudit("cleanup_blocked", { count: selected.length }); throw new CleanupBlockedError("A selected cleanup candidate is no longer safe to delete."); }
  store.appendCleanupAudit("cleanup_requested", { count: selected.length, reclaimBytes: selected.reduce((sum, item) => sum + item.estimatedBytes, 0) });
  const completed: string[] = [];
  for (const item of selected) {
    const generation = item.type === "worktree_node_modules" ? await nodeModulesGeneration(item) : undefined;
    const operation = store.createOperation({ type: operationType(item.type), taskId: item.taskId, notificationId: notificationId(item), idempotencyKey: cleanupOperationKey(item, generation), safeMetadata: { candidateType: item.type, estimatedBytes: item.estimatedBytes, generation } });
    if (operation.state === "persisted") { completed.push(item.candidateId); continue; }
    // A worktree cleanup owns the task lease for its entire delete/persist sequence.
    // Do not register a second task operation: deleteTask receives this exact lease.
    const acquiredTaskLease = item.type === "worktree" && item.taskId ? acquireTaskLock(item.taskId) : undefined;
    if (item.type === "worktree" && !acquiredTaskLease) throw new CleanupBlockedError("Task cleanup is blocked while another operation is running");
    const taskLease = acquiredTaskLease || undefined;
    const end = taskLease ? undefined : beginRegisteredOperation(operation.operationId, operation.type, item.taskId);
    try {
      store.updateOperation(operation.operationId, "executing");
      await deleteCandidate(item, store, options.backupDirectory, taskLease);
      store.updateOperation(operation.operationId, "external_succeeded");
      store.updateOperation(operation.operationId, "persisted");
      completed.push(item.candidateId);
    } catch (error) {
      store.updateOperation(operation.operationId, "reconcile_required", undefined, "cleanup_outcome_unknown");
      store.appendCleanupAudit("cleanup_reconcile_required", { count: 1 });
      throw error;
    } finally { end?.(); if (taskLease && item.taskId) releaseTaskLock(item.taskId, taskLease); }
  }
  store.appendCleanupAudit("cleanup_completed", { count: completed.length });
  return { completed, estimatedBytes: selected.reduce((sum, item) => sum + item.estimatedBytes, 0) };
}

/**
 * `node_modules` is regeneratable, so a prior completed deletion is reusable
 * only while its absence is still true.  An unfinished matching journal row
 * can safely be adopted after a crash once that absence is independently
 * revalidated.
 */
async function cleanupPostconditionsAlreadySatisfied(candidateIds: string[], store: StateStore) {
  if (!Array.isArray(candidateIds) || !candidateIds.length) return false;
  for (const candidateId of candidateIds) {
    const nodeModulesMatch = candidateId.match(/^worktree_node_modules:([0-9a-f-]{36})$/i);
    if (!nodeModulesMatch) {
      if (store.loadOperationByKey(`cleanup:${candidateId}`)?.state !== "persisted") return false;
      continue;
    }
    const task = listTasks().find((item) => item.id === nodeModulesMatch[1]);
    if (!task || !(await nodeModulesAbsentInVerifiedWorktree(task))) return false;
    const operation = store.loadCleanupOperations("cleanup_node_modules", task.id)[0];
    if (!operation) return false;
    if (operation.state !== "persisted") store.updateOperation(operation.operationId, "persisted", undefined, "cleanup_postcondition_adopted");
  }
  return true;
}

async function nodeModulesAbsentInVerifiedWorktree(task: RepoTask) {
  const identity = await inspectWorktree(task);
  if (identity.reasons.length || !identity.root) return false;
  try { await lstat(join(identity.root, "node_modules")); return false; }
  catch (error) { return isMissing(error); }
}

async function nodeModulesGeneration(item: CleanupCandidate) {
  const task = listTasks().find((value) => value.id === item.taskId);
  if (!task) throw new CleanupBlockedError("Task is missing.");
  const inspected = await inspectWorktree(task);
  if (inspected.reasons.length || !inspected.root) throw new CleanupBlockedError("node_modules path is no longer safe.");
  const info = await lstat(join(inspected.root, "node_modules"));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new CleanupBlockedError("node_modules path is no longer safe.");
  return `${info.dev}-${info.ino}-${Math.trunc(info.ctimeMs)}`;
}

function cleanupOperationKey(item: CleanupCandidate, generation?: string) {
  return generation ? `cleanup:${item.candidateId}:${generation}` : `cleanup:${item.candidateId}`;
}

function select(summary: CleanupSummary, candidateIds: string[]) {
  if (!Array.isArray(candidateIds) || !candidateIds.length || candidateIds.length > 50 || new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => typeof id !== "string" || !/^(worktree|worktree_node_modules|backup|notification|outbound_delivery):[0-9a-f-]{36}$/i.test(id))) throw new CleanupBlockedError("Cleanup selection is invalid.");
  const byId = new Map(summary.candidates.map((item) => [item.candidateId, item]));
  const selected = candidateIds.map((id) => byId.get(id));
  if (selected.some((item) => !item)) throw new CleanupBlockedError("A cleanup candidate changed; review the preview again.");
  return selected as CleanupCandidate[];
}
function notificationId(item: CleanupCandidate) { return item.type === "notification" || item.type === "outbound_delivery" ? item.candidateId.split(":")[1] : undefined; }
function operationType(type: CleanupCandidateType) { return type === "worktree" ? "cleanup_worktree" : type === "worktree_node_modules" ? "cleanup_node_modules" : type === "backup" ? "cleanup_backup" : "cleanup_notifications" as const; }
async function deleteCandidate(item: CleanupCandidate, store: StateStore, backupDirectory?: string, taskLease?: symbol) {
  if (item.type === "worktree") { if (!item.taskId || !taskLease) throw new CleanupBlockedError("Worktree identity is invalid."); await deleteTask(item.taskId, { confirmedPrCleanup: true, taskLease }); return; }
  if (item.type === "worktree_node_modules") { const task = listTasks().find((value) => value.id === item.taskId); if (!task) throw new CleanupBlockedError("Task is missing."); const inspected = await inspectWorktree(task); if (inspected.reasons.length || !inspected.root) throw new CleanupBlockedError("node_modules path is no longer safe."); const target = join(inspected.root, "node_modules"); const info = await lstat(target); if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target) throw new CleanupBlockedError("node_modules path is no longer safe."); await rm(target, { recursive: true, force: false }); return; }
  if (item.type === "backup") { await deleteStateBackup(item.candidateId.split(":")[1], { store, directory: backupDirectory }); return; }
  const id = notificationId(item)!; if (item.type === "notification") store.deleteNotificationForRetention(id); else store.deleteDeliveredOutboundForRetention(id);
}
export class CleanupBlockedError extends Error {}
function isMissing(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
