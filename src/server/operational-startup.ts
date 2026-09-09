import { databaseReadiness } from "./operational-health";
import { providerDiagnostics } from "./provider-diagnostics";
import { abortServerStartup, assertActiveServerOwnership, hasActiveServerOwnershipLease, installServerLifecycle } from "./server-lifecycle";
import { initializeTaskRecovery } from "./tasks";
import { onServerOwnershipLost } from "./server-ownership-events";

type StartupState = { state: "UNINITIALIZED" | "STARTING" | "RUNNING" | "FAILED"; promise?: Promise<void>; attemptId?: string };
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
  let lease: Awaited<ReturnType<typeof installServerLifecycle>> | undefined;
  startup.promise = (async () => {
    lease = await installServerLifecycle();
    databaseReadiness();
    await initializeTaskRecovery();
    await providerDiagnostics();
    if (startup.attemptId !== attemptId) throw new Error("Operational startup attempt was invalidated");
    assertActiveServerOwnership(lease);
    startup.state = "RUNNING";
  })().catch(async (error) => { if (startup.attemptId === attemptId) { await abortServerStartup(lease); startup.state = "FAILED"; startup.promise = undefined; } throw error; });
  return startup.promise;
}
