export function acquireRunLock(lock: { current: boolean }) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseRunLock(lock: { current: boolean }) {
  lock.current = false;
}
