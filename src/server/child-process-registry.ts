import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

export type RegisteredChildPurpose = "git" | "github" | "validation" | "agent" | "other";
export type ChildProcessSignalPhase = "requested" | "sent";
type ChildProcessSignalObserver = (signal: NodeJS.Signals, phase: ChildProcessSignalPhase) => void;
export type ActiveChildProcess = {
  id: string;
  operationId?: string;
  purpose: RegisteredChildPurpose;
  pid: number;
  pgid?: number;
  startedAt: string;
  abort: () => void;
  terminate: (options?: { graceMs?: number; onSignal?: ChildProcessSignalObserver }) => Promise<boolean>;
};

type InternalChild = ActiveChildProcess & { child: ChildProcess; closed: Promise<void>; resolveClosed: () => void };
const shared = globalThis as typeof globalThis & { __multiAgentsChildren?: Map<string, InternalChild> };
const active = shared.__multiAgentsChildren ??= new Map<string, InternalChild>();
const operationContext = new AsyncLocalStorage<string | undefined>();

export const CHILD_PROCESS_GRACE_MS = 5_000;

export function withChildProcessOperation<T>(operationId: string | undefined, action: () => T): T {
  return operationContext.run(operationId, action);
}

export function registerChildProcess(input: { child: ChildProcess; purpose: RegisteredChildPurpose; operationId?: string }) {
  const childPid = input.child.pid;
  // Test doubles and a failed spawn may not expose a PID. They cannot be safely
  // signalled, so deliberately leave them out of the shutdown registry.
  if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid < 2) return { id: "", unregister: () => undefined, terminate: async () => false };
  const pid = childPid;
  const id = crypto.randomUUID();
  let resolved = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = () => { if (!resolved) { resolved = true; resolve(); } }; });
  const entry: InternalChild = {
    id, operationId: input.operationId ?? operationContext.getStore(), purpose: input.purpose, pid, pgid: process.platform === "win32" ? undefined : pid,
    startedAt: new Date().toISOString(), child: input.child, closed, resolveClosed,
    abort: () => { signalProcessGroup(entry, "SIGTERM"); },
    terminate: async (options?: { graceMs?: number; onSignal?: ChildProcessSignalObserver }) => terminateOne(entry, options?.graceMs, options?.onSignal),
  };
  active.set(id, entry);
  try {
    // `error` is not proof that a spawned process has gone away.  In
    // particular, a transport error can race a still-running child.  Keep the
    // registry entry (and therefore its shutdown ownership) until close.
    input.child.once("close", () => unregisterChildProcess(id));
    // Also make a registry-only child safe to observe; callers that need the
    // diagnostic install their own error listener.
    input.child.once("error", () => undefined);
  } catch (error) {
    // Registration is atomic from the runner's perspective.  A listener
    // setup failure must not leave an unreachable active entry behind.
    active.delete(id);
    entry.resolveClosed();
    throw error;
  }
  audit("child_process_registered", entry);
  return { id, unregister: () => unregisterChildProcess(id), terminate: (options?: { graceMs?: number; onSignal?: ChildProcessSignalObserver }) => terminateOne(entry, options?.graceMs, options?.onSignal) };
}

export function unregisterChildProcess(id: string) {
  const entry = active.get(id);
  if (!entry) return;
  active.delete(id);
  entry.resolveClosed();
}

export function activeChildProcesses(): ActiveChildProcess[] {
  return [...active.values()].map((entry) => ({
    id: entry.id, operationId: entry.operationId, purpose: entry.purpose, pid: entry.pid, pgid: entry.pgid, startedAt: entry.startedAt,
    abort: entry.abort, terminate: entry.terminate,
  }));
}

export async function terminateRegisteredChildren(options: { graceMs?: number } = {}) {
  const graceMs = options.graceMs ?? CHILD_PROCESS_GRACE_MS;
  const entries = [...active.values()];
  const operationIds = new Set<string>();
  for (const entry of entries) {
    if (!active.has(entry.id)) continue;
    if (entry.operationId) operationIds.add(entry.operationId);
    audit("child_process_shutdown_requested", entry);
    signalProcessGroup(entry, "SIGTERM");
  }
  await Promise.all(entries.map((entry) => waitForClose(entry, graceMs)));
  const survivors = entries.filter((entry) => active.has(entry.id));
  for (const entry of survivors) { audit("child_process_force_killed", entry); signalProcessGroup(entry, "SIGKILL"); }
  await Promise.all(survivors.map((entry) => waitForClose(entry, 1_000)));
  for (const entry of entries.filter((item) => !active.has(item.id))) audit("child_process_terminated", entry);
  return { requested: entries.length, forceKilled: survivors.length, operationIds: [...operationIds] };
}

export function resetChildProcessRegistryForTests() {
  for (const entry of active.values()) entry.resolveClosed();
  active.clear();
}

async function terminateOne(entry: InternalChild, graceMs = CHILD_PROCESS_GRACE_MS, onSignal?: ChildProcessSignalObserver) {
  if (!active.has(entry.id)) return false;
  onSignal?.("SIGTERM", "requested");
  if (signalProcessGroup(entry, "SIGTERM")) onSignal?.("SIGTERM", "sent");
  if (await waitForClose(entry, graceMs)) return true;
  onSignal?.("SIGKILL", "requested");
  if (signalProcessGroup(entry, "SIGKILL")) onSignal?.("SIGKILL", "sent");
  return waitForClose(entry, 1_000);
}

function signalProcessGroup(entry: InternalChild, signal: NodeJS.Signals) {
  if (!active.has(entry.id)) return false;
  try {
    if (entry.pgid && process.platform !== "win32") process.kill(-entry.pgid, signal);
    else entry.child.kill(signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      unregisterChildProcess(entry.id);
      return false;
    }
    throw error;
  }
}

async function waitForClose(entry: InternalChild, timeoutMs: number) {
  if (!active.has(entry.id)) return true;
  return Promise.race([
    entry.closed.then(() => true),
    new Promise<false>((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); timer.unref(); }),
  ]);
}

function audit(type: "child_process_registered" | "child_process_shutdown_requested" | "child_process_terminated" | "child_process_force_killed", entry: ActiveChildProcess) {
  if (process.env.NODE_ENV === "test") return;
  console.info("operational_child_process", JSON.stringify({ type, purpose: entry.purpose, operationId: entry.operationId, startedAt: entry.startedAt }));
}
