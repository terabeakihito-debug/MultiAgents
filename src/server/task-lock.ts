import { beginRegisteredOperation } from "./operation-registry";

const locks = new Set<string>();
const releases = new Map<string, { lease: symbol; release: () => void }>();

export function acquireTaskLock(taskId: string) {
  if (locks.has(taskId)) return false;
  let release: () => void;
  try { release = beginRegisteredOperation(`task:${taskId}`, "task_mutation", taskId); }
  catch { return false; }
  const lease = Symbol(`task:${taskId}`);
  locks.add(taskId);
  releases.set(taskId, { lease, release });
  return lease;
}

/** Releases only the lease acquired by this operation. */
export function releaseTaskLock(taskId: string, lease: symbol) {
  const entry = releases.get(taskId);
  if (!entry || entry.lease !== lease) return;
  locks.delete(taskId);
  entry.release();
  releases.delete(taskId);
}

export function isTaskLocked(taskId: string) {
  return locks.has(taskId);
}

export function clearTaskLocksForTests() {
  locks.clear();
  for (const { release } of releases.values()) release();
  releases.clear();
}
