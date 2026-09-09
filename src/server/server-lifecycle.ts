import { randomUUID } from "node:crypto";
import { enterDrainingMode, enterMaintenanceMode, enterOwnershipLost, ownershipLostEver, transitionOperationState, type LifecycleToken, waitForOperations } from "./operation-registry";
import { activeChildProcesses, CHILD_PROCESS_GRACE_MS, terminateRegisteredChildren } from "./child-process-registry";
import { getStateStore } from "./state-store";
import { acquireServerInstanceLock, type ServerInstanceLease } from "./server-instance-lock";
import { notifyServerOwnershipLost } from "./server-ownership-events";
import { productionOwnershipLostEver } from "./ownership-loss-latch";

export const SHUTDOWN_TIMEOUT_MS = 30_000;
type DrainResult = Awaited<ReturnType<typeof waitForOperations>>;
export type ShutdownPhaseStatus = "completed" | "failed" | "timed_out" | "skipped";
export type ShutdownPhaseResult = { phase: string; required: boolean; status: ShutdownPhaseStatus; errorCode?: string };
export type ShutdownResult = DrainResult & { errors: Error[]; shutdownId: string; phases: ShutdownPhaseResult[]; success: boolean };
export type ShutdownRuntime = {
  resources?: { nextPrepared?: boolean; httpListening?: boolean };
  /** Stop admission immediately; it may begin asynchronous HTTP draining. */
  stopAcceptingHttp?: () => void | Promise<void>;
  /** Finish closing the HTTP listener within the remaining deadline. */
  closeHttp?: (remainingMs: number) => void | Promise<void>;
  /** Finish closing the Next framework within the remaining deadline. */
  closeNext?: (remainingMs: number) => void | Promise<void>;
  /** Release transient bindings that are neither durable state nor HTTP. */
  cleanupRuntime?: () => void | Promise<void>;
};
type Coordinator = { lease?: ServerInstanceLease; installing?: Promise<void>; installed: boolean; ownershipLost: boolean; ownershipAcquired?: boolean; shutdown?: Promise<ShutdownResult>; shutdownId?: string; runtime?: ShutdownRuntime };
const lifecycleKey = Symbol.for("multiagents.lifecycle-coordinator.v1");
const shutdownApiKey = Symbol.for("multiagents.shutdown-api.v1");
const shutdownRuntimeKey = Symbol.for("multiagents.shutdown-runtime.v1");
const shared = globalThis as typeof globalThis & Record<symbol, Coordinator | undefined>;
let retainedCoordinator = shared[lifecycleKey];
if (!retainedCoordinator || typeof retainedCoordinator !== "object") {
  retainedCoordinator = { installed: false, ownershipLost: false };
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
    coordinator.runtime ??= (globalThis as typeof globalThis & Record<symbol, ShutdownRuntime | undefined>)[shutdownRuntimeKey];
    (globalThis as typeof globalThis & Record<symbol, unknown>)[shutdownApiKey] = { requestShutdown };
    if (!coordinator.lease) { coordinator.lease = await acquireServerInstanceLock({ onOwnershipLost: () => {
      markOwnershipLost();
      // An error event does not guarantee Node closes the listening handle.
      // Release remains idempotent, so this cannot close a replacement lease.
      void coordinator.lease?.release();
    } }); coordinator.ownershipAcquired = true; }
    if (coordinator.installed) return;
    coordinator.installed = true;
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
  // Startup can have probes or recovery children in flight.  Close admission
  // first, then drain those children before giving up the R09 lease.
  enterDrainingMode();
  await terminateRegisteredChildren({ graceMs: CHILD_PROCESS_GRACE_MS });
  await waitForOperations(CHILD_PROCESS_GRACE_MS, "DRAINING");
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
export function configureShutdownRuntime(runtime: ShutdownRuntime) {
  coordinator.runtime = runtime;
  // The documented custom Node launcher is plain JavaScript, while the
  // lifecycle is TypeScript bundled by Next.  This retained API is the narrow
  // boundary between them; it deliberately exposes only the joinable request.
  (globalThis as typeof globalThis & Record<symbol, unknown>)[shutdownApiKey] = { requestShutdown };
}

/** Every trigger joins this promise. The outer launcher alone chooses exit. */
export function requestShutdown(reason = "requested", requestedShutdownId?: string) {
  if (coordinator.shutdown) {
    emitShutdownEvent("shutdown_joined", { reason });
    return coordinator.shutdown;
  }
  coordinator.shutdownId = requestedShutdownId ?? randomUUID();
  coordinator.shutdown = finalizeShutdownInternal(SHUTDOWN_TIMEOUT_MS, reason);
  return coordinator.shutdown;
}

/** Controlled shutdown operation; it never resets ownership security state. */
export async function finalizeServerShutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  if (coordinator.shutdown) return coordinator.shutdown;
  coordinator.shutdownId ??= randomUUID();
  coordinator.shutdown = finalizeShutdownInternal(timeoutMs, "programmatic");
  return coordinator.shutdown;
}

async function finalizeShutdownInternal(timeoutMs: number, reason: string): Promise<ShutdownResult> {
  const errors: Error[] = []; const phases: ShutdownPhaseResult[] = []; let result: DrainResult = { timedOut: false, remaining: [] };
  const deadline = Date.now() + timeoutMs;
  emitShutdownEvent("shutdown_started", { reason });
  // Order is intentional: terminally close mutation admission before any
  // network drain, and keep the R09 lease until every other resource is shut.
  enterDrainingMode();
  terminal("mutation_gate", "completed", phases, {}, "closed");
  await runPhase("http_admission", coordinator.runtime?.stopAcceptingHttp, errors, phases, "stopped");
  const registeredChildrenBeforeDrain = activeChildProcesses().length;
  emitShutdownEvent("child_drain_started", { registeredChildrenBeforeDrain });
  let childDrainFailed = false;
  try { result = await drainServerProcesses(remaining(deadline), "STOPPED", false); } catch (error) { childDrainFailed = true; recordFailure("child_drain", error, errors, phases, false); }
  const registeredChildrenAfterDrain = activeChildProcesses().length;
  if (registeredChildrenAfterDrain) { childDrainFailed = true; errors.push(new Error("registered_children_remaining")); }
  if (childDrainFailed) terminal("child_drain", childDrainTimedOut(result, registeredChildrenAfterDrain) ? "timed_out" : "failed", phases, { registeredChildrenBeforeDrain, registeredChildrenAfterDrain });
  else terminal("child_drain", "completed", phases, { registeredChildrenBeforeDrain, registeredChildrenAfterDrain });
  // Each durable entry gets its own attempt. One corrupt journal row must not
  // prevent the remaining entries from being made reconcile-required.
  let unfinished: Array<{ operationId: string }> = [];
  let journalFailed = false; let journalSucceeded = 0; let journalUpdatesFailed = 0;
  emitShutdownEvent("journal_reconcile_started");
  try { unfinished = getStateStore().loadUnfinishedOperations(); } catch (error) { journalFailed = true; recordFailure("journal_reconcile", error, errors, phases, false); }
  for (const operation of unfinished) {
    try { getStateStore().updateOperation(operation.operationId, "reconcile_required", undefined, "shutdown_reconciliation_required"); journalSucceeded++; }
    catch (error) { journalFailed = true; journalUpdatesFailed++; errors.push(asError(error)); }
  }
  let unfinishedOperationsAfter = unfinished.length;
  try { unfinishedOperationsAfter = getStateStore().loadUnfinishedOperations().filter((operation) => operation.state !== "reconcile_required").length; }
  catch (error) { journalFailed = true; errors.push(asError(error)); }
  const journalFields = { unfinishedOperationsBefore: unfinished.length, unfinishedOperationsAfter, attempted: unfinished.length, succeeded: journalSucceeded, failed: journalUpdatesFailed, remaining: unfinishedOperationsAfter };
  if (journalFailed || unfinishedOperationsAfter) terminal("journal_reconcile", "failed", phases, journalFields);
  else terminal("journal_reconcile", "completed", phases, journalFields);
  await runPhase("state_close", () => getStateStore().close(), errors, phases);
  await runPhase("runtime_cleanup", coordinator.runtime?.cleanupRuntime, errors, phases);
  await runPhase("http_close", coordinator.runtime?.closeHttp && (() => coordinator.runtime!.closeHttp!(remaining(deadline))), errors, phases);
  await runPhase("next_close", coordinator.runtime?.closeNext && (() => coordinator.runtime!.closeNext!(remaining(deadline))), errors, phases);
  // Release is deliberately last: readiness is already false but kernel
  // ownership remains held through state, runtime, and HTTP finalization.
  emitShutdownEvent("ownership_release_started");
  if (!coordinator.lease) {
    const ownershipRequired = required("ownership_release");
    terminal("ownership_release", ownershipRequired ? "failed" : "skipped", phases, { reason: ownershipRequired ? "required_cleanup_not_configured" : "no_lease" });
    if (ownershipRequired) errors.push(new Error("ownership_release_required_cleanup_not_configured"));
  }
  else {
    try { const release = await coordinator.lease.release(); if (release.status === "error") throw new Error("server_lock_release_failed"); terminal("ownership_release", "completed", phases); }
    catch (error) { recordFailure("ownership_release", error, errors, phases); }
  }
  const shutdownId = currentShutdownId();
  const timedOut = result.timedOut || remaining(deadline) === 0 || registeredChildrenAfterDrain !== 0 || phases.some((phase) => phase.status === "timed_out");
  const requiredPhases = phases.filter((phase) => phase.required);
  const requiredPhasesCompleted = requiredPhases.filter((phase) => phase.status === "completed").length;
  const requiredPhasesFailed = requiredPhases.length - requiredPhasesCompleted;
  const optionalPhasesSkipped = phases.filter((phase) => !phase.required && phase.status === "skipped").length;
  const success = errors.length === 0 && !timedOut && requiredPhasesFailed === 0;
  emitShutdownEvent("shutdown_completed", { success, errors: errors.length, timedOut, requiredPhasesCompleted, requiredPhasesFailed, optionalPhasesSkipped });
  return { ...result, timedOut, errors, shutdownId, phases, success };
}

function childDrainTimedOut(result: DrainResult, registeredChildrenAfterDrain: number) { return result.timedOut || registeredChildrenAfterDrain > 0; }
function runPhase(name: string, action: (() => void | Promise<void>) | undefined, errors: Error[], phases: ShutdownPhaseResult[], successEvent = "completed") {
  if (!action) { terminal(name, required(name) ? "failed" : "skipped", phases, { reason: required(name) ? "required_cleanup_not_configured" : `${name}_not_configured` }); if (required(name)) errors.push(new Error(`${name}_required_cleanup_not_configured`)); return Promise.resolve(); }
  emitShutdownEvent(`${name}_started`);
  return Promise.resolve().then(action).then(() => terminal(name, "completed", phases, {}, successEvent)).catch((error) => recordFailure(name, error, errors, phases));
}

function terminal(name: string, status: ShutdownPhaseStatus, phases: ShutdownPhaseResult[], fields: Record<string, string | number | boolean | undefined> = {}, successEvent = "completed") {
  const event = status === "completed" ? (successEvent === "completed" ? `${name}_completed` : `${name}_${successEvent}`) : `${name}_${status}`;
  phases.push({ phase: name, required: required(name), status, ...(status === "failed" ? { errorCode: "shutdown_cleanup_failed" } : {}) });
  emitShutdownEvent(event, fields);
}
function recordFailure(failedPhase: string, error: unknown, errors: Error[], phases: ShutdownPhaseResult[], emit = true) { errors.push(asError(error)); if (emit) terminal(failedPhase, errorCode(error) === "shutdown_timed_out" ? "timed_out" : "failed", phases); }
function errorCode(error: unknown) { return error instanceof Error && error.message.includes("timed_out") ? "shutdown_timed_out" : "shutdown_cleanup_failed"; }
const shutdownPhasePolicy: Record<string, "required" | "optional" | "conditional_http" | "conditional_next" | "conditional_ownership"> = {
  mutation_gate: "required", http_admission: "conditional_http", child_drain: "required", journal_reconcile: "required", state_close: "required", runtime_cleanup: "optional", http_close: "conditional_http", next_close: "conditional_next", ownership_release: "conditional_ownership",
};
function required(name: string) {
  const policy = shutdownPhasePolicy[name] ?? "required";
  if (policy === "optional") return false;
  if (policy === "conditional_http") return coordinator.runtime?.resources?.httpListening === true;
  if (policy === "conditional_next") return coordinator.runtime?.resources?.nextPrepared === true;
  if (policy === "conditional_ownership") return coordinator.ownershipAcquired === true;
  return true;
}
function currentShutdownId() { return coordinator.shutdownId ??= randomUUID(); }
export function emitShutdownEvent(phase: string, fields: Record<string, string | number | boolean | undefined> = {}) { console.info("shutdown_event", JSON.stringify({ shutdownId: currentShutdownId(), phase, timestamp: new Date().toISOString(), ...fields })); }

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
function remaining(deadline: number) { return Math.max(0, deadline - Date.now()); }
function markOwnershipLost() {
  if (coordinator.ownershipLost || ownershipLostEver()) return;
  coordinator.ownershipLost = true;
  coordinator.installed = false;
  enterOwnershipLost();
  notifyServerOwnershipLost();
}
