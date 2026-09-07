import { rmSync } from "node:fs";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enterMaintenanceMode, lifecycleState, waitForOperations } from "./operation-registry";
import { CHILD_PROCESS_GRACE_MS, terminateRegisteredChildren } from "./child-process-registry";
import { getStateStore, STATE_DIRECTORY } from "./state-store";

const shared = globalThis as typeof globalThis & { __multiAgentsShutdownInstalled?: boolean };
export const SERVER_LOCK_PATH = join(STATE_DIRECTORY, "server.lock");
export const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function installServerLifecycle() {
  if (shared.__multiAgentsShutdownInstalled) return;
  getStateStore();
  await createServerLock();
  shared.__multiAgentsShutdownInstalled = true;
  // Next.js installs its own signal listeners. Put the state-flush handler first so
  // framework shutdown cannot bypass the operation journal and lock cleanup.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.prependOnceListener(signal, () => { void shutdown(signal); });
  process.once("exit", () => { try { rmSync(SERVER_LOCK_PATH, { force: true }); } catch { /* process is exiting */ } });
}

export async function gracefulDrainForTests(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  return drainServerProcesses(timeoutMs, "STOPPED");
}

export async function drainForMaintenance(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  return drainServerProcesses(timeoutMs, "DRAINING");
}

async function shutdown(signal: NodeJS.Signals) {
  if (lifecycleState() === "STOPPED") return;
  const result = await finalizeShutdown(SHUTDOWN_TIMEOUT_MS);
  if (result.timedOut) console.warn("operational_shutdown", JSON.stringify({ signal, timedOut: true, remaining: result.remaining.length }));
  process.exit(result.timedOut ? 1 : 0);
}

export async function finalizeShutdownForTests(timeoutMs = SHUTDOWN_TIMEOUT_MS, lockPath = SERVER_LOCK_PATH) {
  return finalizeShutdown(timeoutMs, lockPath);
}

async function finalizeShutdown(timeoutMs: number, lockPath = SERVER_LOCK_PATH) {
  const result = await drainServerProcesses(timeoutMs, "STOPPED");
  try { getStateStore().close(); } catch { /* state may already be closed */ }
  await rm(lockPath, { force: true }).catch(() => undefined);
  return result;
}

async function drainServerProcesses(timeoutMs: number, finalState: "STOPPED" | "DRAINING") {
  enterMaintenanceMode();
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
  return waitForOperations(Math.max(0, timeoutMs - (Date.now() - startedAt)), finalState);
}

async function createServerLock() {
  try {
    const info = await lstat(SERVER_LOCK_PATH);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Server lock path is invalid");
    const previous = Number((await readFile(SERVER_LOCK_PATH, "utf8")).trim());
    if (Number.isSafeInteger(previous) && previous > 1 && previous !== process.pid) {
      try { process.kill(previous, 0); throw new Error("Another MultiAgents server process is already running"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeFile(SERVER_LOCK_PATH, `${process.pid}\n`, { mode: 0o600 });
}
