export type LifecycleState = "RUNNING" | "DRAINING" | "STOPPED";
type ActiveOperation = { operationId: string; kind: string; taskId?: string; startedAt: string };

const shared = globalThis as typeof globalThis & {
  __multiAgentsLifecycle?: LifecycleState;
  __multiAgentsOperations?: Map<string, ActiveOperation>;
};
shared.__multiAgentsLifecycle ??= "RUNNING";
const active = shared.__multiAgentsOperations ??= new Map<string, ActiveOperation>();

export function lifecycleState() { return shared.__multiAgentsLifecycle!; }

export function beginRegisteredOperation(operationId: string, kind: string, taskId?: string) {
  if (lifecycleState() !== "RUNNING") throw new OperationUnavailableError("Server is draining; new mutations are temporarily blocked");
  if (active.has(operationId) || (taskId && [...active.values()].some((operation) => operation.taskId === taskId))) {
    throw new OperationUnavailableError("A conflicting operation is already running");
  }
  active.set(operationId, { operationId, kind, taskId, startedAt: new Date().toISOString() });
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    active.delete(operationId);
  };
}

export function activeOperations() { return [...active.values()].map((operation) => ({ ...operation })); }
export function hasActiveTaskOperation(taskId: string) { return [...active.values()].some((operation) => operation.taskId === taskId); }

export function enterMaintenanceMode() {
  if (active.size) throw new OperationUnavailableError("Cannot enter maintenance mode while operations are running");
  shared.__multiAgentsLifecycle = "DRAINING";
}

export function leaveMaintenanceMode() {
  if (lifecycleState() === "STOPPED") throw new OperationUnavailableError("Server has stopped");
  shared.__multiAgentsLifecycle = "RUNNING";
}

export async function drainOperations(timeoutMs = 30_000) {
  shared.__multiAgentsLifecycle = "DRAINING";
  const deadline = Date.now() + timeoutMs;
  while (active.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const timedOut = active.size > 0;
  shared.__multiAgentsLifecycle = "STOPPED";
  return { timedOut, remaining: activeOperations() };
}

export function resetOperationRegistryForTests() {
  active.clear();
  shared.__multiAgentsLifecycle = "RUNNING";
}

export class OperationUnavailableError extends Error {}
