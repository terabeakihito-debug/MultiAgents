const locks = new Set<string>();

export function acquireTaskLock(taskId: string) {
  if (locks.has(taskId)) return false;
  locks.add(taskId);
  return true;
}

export function releaseTaskLock(taskId: string) {
  locks.delete(taskId);
}

export function isTaskLocked(taskId: string) {
  return locks.has(taskId);
}

export function clearTaskLocksForTests() {
  locks.clear();
}
