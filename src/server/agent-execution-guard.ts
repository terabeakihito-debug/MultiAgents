import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cleanupDeferredRuntimeBinding } from "./immutable-executable-binding";
import { getStateStore, type UnresolvedAgentProcess } from "./state-store";

export type CapturedUnresolvedExecution = Omit<UnresolvedAgentProcess, "phase">;
type UnconfirmedExecution = { reconcile?: () => void | Promise<void>; durableExecutionId?: string; onRelease?: () => void; reconcilePromise?: Promise<void> };
type ProcessIdentity = { pid: number; pgid: number; startTicks: string };
/** A reconciliation decision is deliberately not boolean: only TERMINATED releases ownership. */
export type UnresolvedProcessReconciliationResult = "ALIVE" | "TERMINATED" | "UNKNOWN" | "INSPECTION_FAILED";
type RestoreState = "NOT_STARTED" | "RESTORING" | "READY" | "FAILED";
const shared = globalThis as typeof globalThis & {
  __multiAgentsActiveExecutions?: number;
  __multiAgentsUnconfirmedExecutions?: Map<string, UnconfirmedExecution>;
  __multiAgentsUnresolvedRestoreState?: RestoreState;
  __multiAgentsUnresolvedRestorePromise?: Promise<void>;
};
shared.__multiAgentsActiveExecutions ??= 0;
shared.__multiAgentsUnconfirmedExecutions ??= new Map<string, UnconfirmedExecution>();
// Unit fixtures do not boot operational startup. Production begins fail-closed.
shared.__multiAgentsUnresolvedRestoreState ??= process.env.NODE_ENV === "test" ? "READY" : "NOT_STARTED";

/** An admission lease is acquired synchronously immediately before spawn. */
export function beginAgentExecution() {
  assertAgentExecutionAdmissible();
  shared.__multiAgentsActiveExecutions! += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    shared.__multiAgentsActiveExecutions = Math.max(0, shared.__multiAgentsActiveExecutions! - 1);
  };
}

export function assertAgentExecutionAdmissible() {
  if (shared.__multiAgentsUnresolvedRestoreState !== "READY") throw new Error("unresolved_agent_restore_not_ready");
  if (hasUnconfirmedAgentExecution()) throw new Error("unresolved_agent_process");
}
export function isAgentExecutionActive() { return shared.__multiAgentsActiveExecutions! > 0 || hasUnconfirmedAgentExecution(); }
export function isOrdinaryAgentExecutionActive() { return shared.__multiAgentsActiveExecutions! > 0; }

/** Capture identity before optional setup can allow the process leader to exit. */
export function captureUnresolvedAgentExecution(input: { provider: UnresolvedAgentProcess["provider"]; pid: number; runtimeBindingPath?: string }): CapturedUnresolvedExecution {
  const identity = readProcessIdentity(input.pid) ?? (process.env.NODE_ENV === "test" && Number.isSafeInteger(input.pid) && input.pid > 1
    ? { pid: input.pid, pgid: input.pid, startTicks: "1" } : undefined);
  if (!identity || identity.pgid < 2) throw new Error("Unable to establish durable managed-process identity");
  return { executionId: randomUUID(), provider: input.provider, pid: identity.pid, pgid: identity.pgid,
    leaderStartTicks: identity.startTicks, runtimeBindingPath: input.runtimeBindingPath, createdAt: new Date().toISOString() };
}

/** Persists previously captured ownership before the caller's lease can be released. */
export function durablyQuarantineCapturedUnresolvedAgentExecution(record: CapturedUnresolvedExecution, reconcile?: () => void | Promise<void>) {
  getStateStore().saveUnresolvedAgentProcess({ ...record, phase: "UNCONFIRMED" });
  return quarantineUnconfirmedAgentExecution({ durableExecutionId: record.executionId, reconcile: async () => { await reconcile?.(); } });
}
export function durablyQuarantineUnconfirmedAgentExecution(input: { provider: UnresolvedAgentProcess["provider"]; pid: number; runtimeBindingPath?: string; reconcile?: () => void | Promise<void> }) {
  return durablyQuarantineCapturedUnresolvedAgentExecution(captureUnresolvedAgentExecution(input), input.reconcile);
}

/** Restores durable quarantine before startup can report provider readiness. */
export async function restoreDurableUnconfirmedAgentExecutions() {
  if (shared.__multiAgentsUnresolvedRestoreState === "READY") return;
  if (shared.__multiAgentsUnresolvedRestoreState === "RESTORING") return shared.__multiAgentsUnresolvedRestorePromise!;
  shared.__multiAgentsUnresolvedRestoreState = "RESTORING";
  const restore = (async () => {
    try {
      for (const record of getStateStore().loadUnresolvedAgentProcesses()) installDurableRecord(record);
      shared.__multiAgentsUnresolvedRestoreState = "READY";
    } catch (error) {
      shared.__multiAgentsUnresolvedRestoreState = "FAILED";
      throw error;
    } finally { shared.__multiAgentsUnresolvedRestorePromise = undefined; }
  })();
  shared.__multiAgentsUnresolvedRestorePromise = restore;
  return restore;
}

function installDurableRecord(record: UnresolvedAgentProcess) {
  if ([...shared.__multiAgentsUnconfirmedExecutions!.values()].some((entry) => entry.durableExecutionId === record.executionId)) return;
  const timer = { value: undefined as NodeJS.Timeout | undefined };
  const entry: UnconfirmedExecution = { durableExecutionId: record.executionId };
  const release = quarantineUnconfirmedAgentExecution(entry);
  entry.onRelease = () => { if (timer.value) clearInterval(timer.value); };
  entry.reconcile = async () => {
    const status = inspectUnresolvedAgentProcess(record);
    if (status === "ALIVE") { try { process.kill(-record.pgid, "SIGKILL"); } catch { /* retained and retried */ } return; }
    if (status !== "TERMINATED") return; // unknown inspection remains fail-closed
    const store = getStateStore();
    if (record.phase === "UNCONFIRMED") {
      store.updateUnresolvedAgentProcessPhase(record.executionId, "PROCESS_GONE_CLEANUP_PENDING");
      record.phase = "PROCESS_GONE_CLEANUP_PENDING";
    }
    if (record.phase === "PROCESS_GONE_CLEANUP_PENDING") {
      await cleanupDeferred(record);
      store.updateUnresolvedAgentProcessPhase(record.executionId, "PROCESS_GONE_CLEANED");
      record.phase = "PROCESS_GONE_CLEANED";
    }
    // Delete is deliberately last. A deletion failure retains the barrier;
    // CLEANED prevents unsafe duplicate runtime cleanup on retry.
    release.release();
  };
  timer.value = setInterval(() => { void runSerializedReconciliation(entry); }, 1_000);
  timer.value.unref();
  void runSerializedReconciliation(entry);
}

/** Transfers admission ownership after a terminal but unconfirmed child error. */
export function quarantineUnconfirmedAgentExecution(input: UnconfirmedExecution = {}) {
  const id = randomUUID();
  shared.__multiAgentsUnconfirmedExecutions!.set(id, input);
  let released = false;
  return { id, release: () => {
    if (released) return;
    if (input.durableExecutionId) getStateStore().deleteUnresolvedAgentProcess(input.durableExecutionId);
    released = true;
    input.onRelease?.();
    shared.__multiAgentsUnconfirmedExecutions!.delete(id);
  } };
}
export function hasUnconfirmedAgentExecution() { return shared.__multiAgentsUnconfirmedExecutions!.size > 0; }
/** Shutdown joins the same serialized reconciliation authority. */
export async function reconcileUnconfirmedAgentExecutions() { await Promise.all([...shared.__multiAgentsUnconfirmedExecutions!.values()].map(runSerializedReconciliation)); }
function runSerializedReconciliation(entry: UnconfirmedExecution) {
  if (entry.reconcilePromise) return entry.reconcilePromise;
  // Defer callback execution by one microtask so this reference is installed
  // before a synchronous throw can settle the operation.
  const operation = Promise.resolve().then(() => entry.reconcile?.()).catch((error) => {
    console.warn("agent_unresolved_reconcile_failed", JSON.stringify({ reason: error instanceof Error ? error.message : "unknown" }));
  });
  entry.reconcilePromise = operation;
  void operation.finally(() => {
    // A prior operation must never erase a newer operation's reference.
    if (entry.reconcilePromise === operation) entry.reconcilePromise = undefined;
  });
  return operation;
}
function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 2) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); const closing = stat.lastIndexOf(")");
    const fields = stat.slice(closing + 2).trim().split(/\s+/); const pgid = Number(fields[2]); const startTicks = fields[19];
    if (!Number.isSafeInteger(pgid) || pgid < 2 || !/^\d{1,30}$/.test(startTicks ?? "")) return undefined;
    return { pid, pgid, startTicks };
  } catch { return undefined; }
}
/**
 * Establishes the positive process-death boundary used by all reconciliation.
 * Ambiguous identity or a failed inspection is never treated as termination.
 */
export function inspectUnresolvedAgentProcess(record: Pick<UnresolvedAgentProcess, "pid" | "pgid" | "leaderStartTicks">): UnresolvedProcessReconciliationResult {
  const leader = readProcessIdentity(record.pid);
  if (leader && leader.startTicks === record.leaderStartTicks && leader.pgid === record.pgid) {
    const group = processGroupStatus(record.pgid);
    // ESRCH for the managed process group is an explicit OS termination
    // boundary even if a racing /proc read just observed the leader.
    return group === "alive" ? "ALIVE" : group === "gone" ? "TERMINATED" : "INSPECTION_FAILED";
  }
  const group = processGroupStatus(record.pgid);
  if (group === "gone") return "TERMINATED";
  // A living group paired with a missing/mismatched leader might be a
  // descendant or reused identity. It is not safe evidence of ownership.
  return group === "alive" ? "UNKNOWN" : "INSPECTION_FAILED";
}
function processGroupStatus(pgid: number): "alive" | "gone" | "inspection_failed" {
  try { process.kill(-pgid, 0); return "alive"; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH" ? "gone" : "inspection_failed"; }
}
async function cleanupDeferred(record: UnresolvedAgentProcess) { if (record.runtimeBindingPath) await cleanupDeferredRuntimeBinding(record.runtimeBindingPath); }
