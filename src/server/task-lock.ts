import { beginRegisteredOperation } from "./operation-registry";

const locks = new Set<string>();
const releases = new Map<string, () => void>();

export function acquireTaskLock(taskId: string) {
  if (locks.has(taskId)) return false;
  let release: () => void;
  try { release = beginRegisteredOperation(`task:${taskId}`, "task_mutation", taskId); }
  catch { return false; }
  locks.add(taskId);
  releases.set(taskId, release);
  return true;
}

export function releaseTaskLock(taskId: string) {
  locks.delete(taskId);
  releases.get(taskId)?.();
  releases.delete(taskId);
}

export function isTaskLocked(taskId: string) {
  return locks.has(taskId);
}

export function clearTaskLocksForTests() {
  locks.clear();
  for (const release of releases.values()) release();
  releases.clear();
}
