import { databaseReadiness } from "./operational-health";
import { providerDiagnostics } from "./provider-diagnostics";
import { abortServerStartup, assertActiveServerOwnership, hasActiveServerOwnershipLease, installServerLifecycle } from "./server-lifecycle";
import type { ServerInstanceLease } from "./server-instance-lock";
import { initializeTaskRecovery } from "./tasks";
import { onServerOwnershipLost } from "./server-ownership-events";
import { hasMutationOwnershipPredicate, lifecycleState, ownershipLostEver } from "./operation-registry";
import { restoreDurableUnconfirmedAgentExecutions } from "./agent-execution-guard";

type StartupState = { state: "UNINITIALIZED" | "STARTING" | "RUNNING" | "FAILED"; promise?: Promise<void>; attemptId?: string; lease?: ServerInstanceLease };
// Startup state is module-private.  Ownership is revalidated before RUNNING,
// and the process-global ownership latch in lifecycle rejects any post-loss
// restart after a module reload.
const startup: StartupState = { state: "UNINITIALIZED" };
onServerOwnershipLost(() => { startup.state = "FAILED"; startup.promise = undefined; startup.attemptId = undefined; });

export function initializeOperationalStartup() {
  if (startup.state === "RUNNING" && startup.promise) {
    if (hasActiveServerOwnershipLease()) return startup.promise;
    startup.state = "FAILED"; startup.promise = undefined;
    return Promise.reject(new Error("Operational startup cannot report RUNNING without a server ownership lease"));
  }
  if (startup.state === "STARTING" && startup.promise) return startup.promise;
  startup.state = "STARTING"; startup.attemptId = crypto.randomUUID();
  const attemptId = startup.attemptId;
  startup.promise = (async () => {
    startup.lease = await installServerLifecycle();
    databaseReadiness();
    // This barrier installs durable unresolved-process ownership before any
    // provider can become ready or an execution can be admitted.
    await restoreDurableUnconfirmedAgentExecutions();
    await initializeTaskRecovery();
    assertCurrentAttempt(attemptId);
    await providerDiagnostics();
    assertCurrentAttempt(attemptId);
    assertOperationalStartupReady(startup.lease);
    startup.state = "RUNNING";
  })().catch(async (error) => { if (startup.attemptId === attemptId) { await abortServerStartup(startup.lease); startup.lease = undefined; startup.state = "FAILED"; startup.promise = undefined; } throw error; });
  return startup.promise;
}

/** Explicit readiness gate shared by the custom launcher and instrumentation. */
export function assertOperationalStartupReady(lease?: ServerInstanceLease): asserts lease is ServerInstanceLease {
  if (!lease || lifecycleState() !== "RUNNING" || ownershipLostEver() || !hasMutationOwnershipPredicate()) {
    throw new Error("Operational startup readiness assertion failed");
  }
  assertActiveServerOwnership(lease);
}

/** Cancels an in-flight initializer before it can start further reconciliation. */
export async function abortOperationalStartup() {
  if (startup.state !== "STARTING") return;
  startup.attemptId = undefined;
  await abortServerStartup(startup.lease);
  startup.lease = undefined;
  startup.state = "FAILED";
  startup.promise = undefined;
}

function assertCurrentAttempt(attemptId: string) {
  if (startup.attemptId !== attemptId) throw new Error("Operational startup attempt was invalidated");
}
