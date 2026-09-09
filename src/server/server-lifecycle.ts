import { enterDrainingMode, enterMaintenanceMode, enterOwnershipLost, ownershipLostEver, transitionOperationState, type LifecycleToken, waitForOperations } from "./operation-registry";
import { CHILD_PROCESS_GRACE_MS, terminateRegisteredChildren } from "./child-process-registry";
import { getStateStore } from "./state-store";
import { acquireServerInstanceLock, type ServerInstanceLease } from "./server-instance-lock";
import { notifyServerOwnershipLost } from "./server-ownership-events";
import { productionOwnershipLostEver } from "./ownership-loss-latch";

export const SHUTDOWN_TIMEOUT_MS = 30_000;
type DrainResult = Awaited<ReturnType<typeof waitForOperations>>;
export type ShutdownResult = DrainResult & { errors: Error[] };
type Coordinator = { lease?: ServerInstanceLease; installing?: Promise<void>; installed: boolean; ownershipLost: boolean; shutdown?: Promise<ShutdownResult>; exiting: boolean; listeners?: Array<{ signal: NodeJS.Signals; listener: () => void }> };
const lifecycleKey = Symbol.for("multiagents.lifecycle-coordinator.v1");
const shared = globalThis as typeof globalThis & Record<symbol, Coordinator | undefined>;
let retainedCoordinator = shared[lifecycleKey];
if (!retainedCoordinator || typeof retainedCoordinator !== "object") {
  retainedCoordinator = { installed: false, ownershipLost: false, exiting: false };
  Object.defineProperty(shared, lifecycleKey, { value: retainedCoordinator, writable: false, configurable: false, enumerable: false });
}
const coordinator: Coordinator = retainedCoordinator;

export async function installServerLifecycle(): Promise<ServerInstanceLease> {
  if (coordinator.installed) {
    if (!hasActiveServerOwnershipLease()) { markOwnershipLost(); throw new Error("Server lifecycle has no active ownership lease; restart required"); }
    return coordinator.lease!;
  }
  if (coordinator.ownershipLost || ownershipLostEver()) throw new Error("Server ownership was lost; restart required");
  coordinator.installing ??= (async () => {
    if (!coordinator.lease) coordinator.lease = await acquireServerInstanceLock({ onOwnershipLost: () => {
      markOwnershipLost();
      // An error event does not guarantee Node closes the listening handle.
      // Release remains idempotent, so this cannot close a replacement lease.
      void coordinator.lease?.release();
    } });
    if (coordinator.installed) return;
    coordinator.listeners ??= (["SIGTERM", "SIGINT"] as const).map((signal) => ({ signal, listener: () => { void requestShutdown(signal, true); } }));
    coordinator.installed = true;
    for (const { signal, listener } of coordinator.listeners!) process.on(signal, listener);
  })();
  try {
    await coordinator.installing;
    if (!hasActiveServerOwnershipLease()) { markOwnershipLost(); throw new Error("Server lifecycle has no active ownership lease; restart required"); }
    // A normal aborted startup may retry in-process.  This is intentionally
    // impossible after ownership loss because the transition guard is
    // governed by the process-global security condition.
    if (!transitionOperationState("RUNNING")) throw new Error("Server ownership was lost; restart required");
    return coordinator.lease!;
  } finally { coordinator.installing = undefined; }
}

/** A RUNNING startup state is valid only while this retained socket lease is live. */
export function hasActiveServerOwnershipLease() { const lease = coordinator.lease; return coordinator.installed && lease !== undefined && lease.isActive() && !coordinator.ownershipLost && !ownershipLostEver() && !productionOwnershipLostEver() && !coordinator.shutdown; }
export function assertActiveServerOwnership(expectedLease?: ServerInstanceLease): asserts expectedLease is ServerInstanceLease {
  if (!hasActiveServerOwnershipLease() || (expectedLease && coordinator.lease !== expectedLease)) throw new Error("Server ownership lease is not active; restart required");
}

/** Startup callers use this when readiness/reconciliation fails after leasing. */
export async function abortServerStartup(expectedLease?: ServerInstanceLease) {
  if (coordinator.shutdown) return coordinator.shutdown;
  const lease = coordinator.lease;
  if (expectedLease && lease !== expectedLease) return;
  if (lease) {
    const release = await lease.release();
    if (release.status === "released" || release.status === "alreadyReleased") {
      coordinator.lease = undefined; coordinator.installed = false;
      // Do not restore a pre-await snapshot: loss may have arrived while the
      // socket close/release promise was pending.
      if (coordinator.ownershipLost || ownershipLostEver()) enterOwnershipLost();
      else enterDrainingMode();
    }
  }
}

/** Drains active operations as part of a controlled lifecycle shutdown. */
export async function gracefulDrainOperations(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  return drainServerProcesses(timeoutMs, "STOPPED");
}

export async function drainForMaintenance(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  // Operator maintenance is resumable only while ownership remains valid.
  const token = enterMaintenanceMode();
  return drainServerProcesses(timeoutMs, "MAINTENANCE", false, token);
}

/** Signal and programmatic shutdown requests join this one idempotent path. */
export function requestShutdown(reason = "requested", exitWhenDone = false) {
  void reason;
  coordinator.shutdown ??= finalizeShutdownInternal(SHUTDOWN_TIMEOUT_MS).then((result) => {
    if (exitWhenDone && !coordinator.exiting && process.env.NODE_ENV !== "test") { coordinator.exiting = true; process.exitCode = result.timedOut || result.errors.length ? 1 : 0; }
    return result;
  });
  return coordinator.shutdown;
}

/** Controlled shutdown operation; it never resets ownership security state. */
export async function finalizeServerShutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  return finalizeShutdownInternal(timeoutMs);
}

async function finalizeShutdownInternal(timeoutMs: number): Promise<ShutdownResult> {
  const errors: Error[] = []; let result: DrainResult = { timedOut: false, remaining: [] };
  try { result = await drainServerProcesses(timeoutMs, "STOPPED"); } catch (error) { errors.push(asError(error)); }
  // Journal, state, and lease cleanup each run even if an earlier subsystem failed.
  try { for (const operation of getStateStore().loadUnfinishedOperations()) getStateStore().updateOperation(operation.operationId, "reconcile_required", undefined, "shutdown_reconciliation_required"); } catch (error) { errors.push(asError(error)); }
  try { getStateStore().close(); } catch (error) { errors.push(asError(error)); }
  try { const release = await coordinator.lease?.release(); if (release && release.status === "error") errors.push(new Error("server_lock_release_failed")); } catch (error) { errors.push(asError(error)); }
  return { ...result, errors };
}

async function drainServerProcesses(timeoutMs: number, finalState: "STOPPED" | "DRAINING" | "MAINTENANCE", enterDraining = true, expected?: LifecycleToken) {
  if (enterDraining) enterDrainingMode();
  const startedAt = Date.now();
  const children = await terminateRegisteredChildren({ graceMs: Math.min(CHILD_PROCESS_GRACE_MS, timeoutMs) });
  for (const operationId of children.operationIds) {
    try {
      const operation = getStateStore().loadOperation(operationId);
      if (operation && !["persisted", "failed"].includes(operation.state)) {
        getStateStore().updateOperation(operationId, "reconcile_required", undefined, "shutdown_child_terminated");
        if (process.env.NODE_ENV !== "test") console.info("operational_shutdown", JSON.stringify({ type: "shutdown_operation_reconcile_required", operationId }));
      }
    } catch { /* shutdown must continue even if state is already unavailable */ }
  }
  return waitForOperations(Math.max(0, timeoutMs - (Date.now() - startedAt)), finalState, expected);
}
function asError(error: unknown) { return error instanceof Error ? error : new Error("shutdown_cleanup_failed"); }
function markOwnershipLost() {
  if (coordinator.ownershipLost || ownershipLostEver()) return;
  coordinator.ownershipLost = true;
  coordinator.installed = false;
  enterOwnershipLost();
  notifyServerOwnershipLost();
}
