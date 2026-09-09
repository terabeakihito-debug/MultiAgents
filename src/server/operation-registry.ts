export type LifecycleState = "RUNNING" | "MAINTENANCE" | "DRAINING" | "OWNERSHIP_LOST" | "STOPPED";
type ActiveOperation = { operationId: string; kind: string; taskId?: string; startedAt: string };
export type LifecycleToken = Readonly<{ epoch: number; state: LifecycleState }>;
export type OperationRegistry = ReturnType<typeof createOperationRegistryState>;
import { markProductionOwnershipLost, productionOwnershipLostEver } from "./ownership-loss-latch";

/** Creates an independent state machine.  A lost instance has no reset path. */
export function createOperationRegistryState(ownershipActive: () => boolean = () => false) {
  let lifecycle: LifecycleState = "RUNNING", epoch = 0, lostEver = false;
  const active = new Map<string, ActiveOperation>();
  const lifecycleState = () => lifecycle;
  const ownershipLostEver = () => lostEver;
  const lifecycleToken = (): LifecycleToken => ({ epoch, state: lifecycle });
  const hasMutationOwnershipPredicate = () => true;
  const canAdmitMutations = () => lifecycle === "RUNNING" && !lostEver && ownershipActive();
  const transitionOperationState = (next: LifecycleState, expected?: LifecycleToken) => {
    if (expected && (expected.epoch !== epoch || expected.state !== lifecycle)) return false;
    if (lostEver && ["RUNNING", "MAINTENANCE", "DRAINING"].includes(next)) return false;
    if (lifecycle === next) return true;
    lifecycle = next; epoch++;
    return true;
  };
  const beginRegisteredOperation = (operationId: string, kind: string, taskId?: string) => {
    if (lifecycle !== "RUNNING") throw new OperationUnavailableError("Server is draining; new mutations are temporarily blocked");
    if (!canAdmitMutations()) throw new OperationUnavailableError("Server ownership lost; restart required");
    if (active.has(operationId) || (taskId && [...active.values()].some((operation) => operation.taskId === taskId))) throw new OperationUnavailableError("A conflicting operation is already running");
    active.set(operationId, { operationId, kind, taskId, startedAt: new Date().toISOString() });
    let finished = false;
    return () => { if (!finished) { finished = true; active.delete(operationId); } };
  };
  const activeOperations = () => [...active.values()].map((operation) => ({ ...operation }));
  const hasActiveTaskOperation = (taskId: string) => [...active.values()].some((operation) => operation.taskId === taskId);
  const enterMaintenanceMode = () => {
    if (lostEver || lifecycle !== "RUNNING" || !transitionOperationState("MAINTENANCE")) throw new OperationUnavailableError("Server is unavailable for maintenance changes");
    return lifecycleToken();
  };
  const leaveMaintenanceMode = () => {
    if (lostEver || lifecycle !== "MAINTENANCE" || !transitionOperationState("RUNNING")) throw new OperationUnavailableError("Server maintenance cannot be resumed in the current lifecycle state");
  };
  const enterOwnershipLost = () => { lostEver = true; return transitionOperationState("OWNERSHIP_LOST"); };
  const enterDrainingMode = () => { if (lifecycle !== "OWNERSHIP_LOST" && lifecycle !== "STOPPED") transitionOperationState("DRAINING"); };
  const waitForOperations = async (timeoutMs: number, finalState: LifecycleState = "STOPPED", expected?: LifecycleToken) => {
    const deadline = Date.now() + timeoutMs;
    while (active.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const timedOut = active.size > 0; transitionOperationState(finalState, expected);
    return { timedOut, remaining: activeOperations() };
  };
  const drainOperations = async (timeoutMs = 30_000) => { enterDrainingMode(); return waitForOperations(timeoutMs, "STOPPED"); };
  return { lifecycleState, ownershipLostEver, lifecycleToken, hasMutationOwnershipPredicate, canAdmitMutations, transitionOperationState, beginRegisteredOperation, activeOperations, hasActiveTaskOperation, enterMaintenanceMode, leaveMaintenanceMode, enterOwnershipLost, enterDrainingMode, waitForOperations, drainOperations };
}

// This object is module-local.  Reloading it may create a fresh phase machine,
// but the process-global ownership-loss latch remains terminal and gates every
// admission decision.
const lifecycleCoordinatorKey = Symbol.for("multiagents.lifecycle-coordinator.v1");
const production = createOperationRegistryState(() => {
  const coordinator = (globalThis as typeof globalThis & Record<symbol, { installed?: boolean; ownershipLost?: boolean; shutdown?: unknown; lease?: { isActive?: () => boolean } } | undefined>)[lifecycleCoordinatorKey];
  return coordinator?.installed === true && coordinator.ownershipLost !== true && coordinator.shutdown === undefined && coordinator.lease?.isActive?.() === true && !productionOwnershipLostEver();
});

export function lifecycleState() { return production.lifecycleState(); }
/** Process-lifetime security condition, deliberately independent of phase. */
export function ownershipLostEver() { return productionOwnershipLostEver(); }
export function lifecycleToken(): LifecycleToken { return production.lifecycleToken(); }
export function hasMutationOwnershipPredicate() { return production.hasMutationOwnershipPredicate(); }
/** Shared server-side admission invariant for routes and durable operations. */
export function canAdmitMutations() { return !productionOwnershipLostEver() && production.canAdmitMutations(); }

/** The sole state writer. Ownership loss cannot be overwritten by delayed work. */
export function transitionOperationState(next: LifecycleState, expected?: LifecycleToken) { return production.transitionOperationState(next, expected); }

export function beginRegisteredOperation(operationId: string, kind: string, taskId?: string) { return production.beginRegisteredOperation(operationId, kind, taskId); }
export function activeOperations() { return production.activeOperations(); }
export function hasActiveTaskOperation(taskId: string) { return production.hasActiveTaskOperation(taskId); }

export function enterMaintenanceMode() { return production.enterMaintenanceMode(); }

export function leaveMaintenanceMode() { return production.leaveMaintenanceMode(); }

/** Ownership loss is terminal for this process; only a restart can resume mutations. */
export function enterOwnershipLost() { markProductionOwnershipLost(); return production.enterOwnershipLost(); }
export function enterDrainingMode() { return production.enterDrainingMode(); }

export async function drainOperations(timeoutMs = 30_000) { return production.drainOperations(timeoutMs); }

export async function waitForOperations(timeoutMs: number, finalState: LifecycleState = "STOPPED", expected?: LifecycleToken) { return production.waitForOperations(timeoutMs, finalState, expected); }

export class OperationUnavailableError extends Error {}
