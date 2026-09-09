import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeChildProcesses, registerChildProcess, resetChildProcessRegistryForTests, terminateRegisteredChildren } from "./child-process-registry";
import { StateStore, replaceStateStoreForTests } from "./state-store";
import { configureShutdownRuntime, finalizeServerShutdown, gracefulDrainOperations } from "./server-lifecycle";
import { createOperationRegistryState } from "./operation-registry";

function fakeChild(pid = 42) {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  Object.defineProperty(child, "pid", { value: pid });
  child.kill = vi.fn();
  return child as ChildProcess;
}

afterEach(() => {
  resetChildProcessRegistryForTests();
  replaceStateStoreForTests(new StateStore(":memory:"));
  vi.restoreAllMocks();
});

describe("shutdown child process registry", () => {
  it.each(["git", "github", "validation", "agent"] as const)("registers %s children and unregisters normal completion", (purpose) => {
    const child = fakeChild();
    registerChildProcess({ child, purpose });
    expect(activeChildProcesses()).toMatchObject([{ purpose, pid: 42, pgid: 42 }]);
    child.emit("close", 0, null);
    expect(activeChildProcesses()).toEqual([]);
  });

  it("keeps a child registered after an error until close confirms termination", () => {
    const child = fakeChild(43);
    registerChildProcess({ child, purpose: "agent" });
    child.emit("error", new Error("transport failure"));
    expect(activeChildProcesses()).toMatchObject([{ pid: 43, purpose: "agent" }]);
    child.emit("close", null, "SIGTERM");
    expect(activeChildProcesses()).toEqual([]);
  });

  it("uses process-group TERM, then KILL only for surviving registered children", async () => {
    const first = fakeChild(101); const second = fakeChild(102);
    registerChildProcess({ child: first, purpose: "git" });
    registerChildProcess({ child: second, purpose: "github" });
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: NodeJS.Signals) => {
      if (pid === -101 && signal === "SIGTERM") first.emit("close", null, "SIGTERM");
      return true;
    }) as typeof process.kill);
    const result = await terminateRegisteredChildren({ graceMs: 1 });
    expect(kill).toHaveBeenCalledWith(-101, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-102, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-102, "SIGKILL");
    expect(result).toMatchObject({ requested: 2, forceKilled: 1 });
    expect(activeChildProcesses().map((entry) => entry.pid)).toEqual([102]);
  });

  it("treats already-exited ESRCH as safe and never signals unregistered processes", async () => {
    const child = fakeChild(333);
    registerChildProcess({ child, purpose: "validation" });
    const error = Object.assign(new Error("gone"), { code: "ESRCH" });
    const kill = vi.spyOn(process, "kill").mockImplementation((() => { throw error; }) as typeof process.kill);
    await expect(terminateRegisteredChildren({ graceMs: 1 })).resolves.toMatchObject({ requested: 1 });
    expect(kill).toHaveBeenCalledWith(-333, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-444, expect.anything());
    expect(activeChildProcesses()).toEqual([]);
  });

  it("marks a shutdown-interrupted durable operation reconcile_required", async () => {
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const operation = store.createOperation({ type: "git_push", idempotencyKey: `git_push:${crypto.randomUUID()}` });
    store.updateOperation(operation.operationId, "executing");
    const child = fakeChild(555);
    registerChildProcess({ child, purpose: "git", operationId: operation.operationId });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: NodeJS.Signals) => {
      if (pid === -555 && signal === "SIGTERM") child.emit("close", null, "SIGTERM");
      return true;
    }) as typeof process.kill);
    await gracefulDrainOperations(100);
    expect(store.loadOperation(operation.operationId)).toMatchObject({ state: "reconcile_required", errorCode: "shutdown_child_terminated" });
  });

  it("stops a delayed GitHub-create mock before it can report success and leaves PR recovery manual", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-phase196-gh-")); const marker = join(root, "pr-created");
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const operation = store.createOperation({ type: "pr_create", idempotencyKey: `pr_create:${crypto.randomUUID()}` }); store.updateOperation(operation.operationId, "executing");
    const source = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'created'), 1000); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: "ignore" });
    registerChildProcess({ child, purpose: "github", operationId: operation.operationId });
    await gracefulDrainOperations(500);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.loadOperation(operation.operationId)).toMatchObject({ state: "reconcile_required", errorCode: "shutdown_child_terminated" });
  });

  it("applies the same termination policy before maintenance mode becomes resumable", async () => {
    const child = fakeChild(666); registerChildProcess({ child, purpose: "agent" });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: NodeJS.Signals) => {
      if (pid === -666 && signal === "SIGTERM") child.emit("close", null, "SIGTERM");
      return true;
    }) as typeof process.kill);
    await terminateRegisteredChildren({ graceMs: 100 });
    const registry = createOperationRegistryState(() => true);
    registry.enterMaintenanceMode();
    expect(registry.lifecycleState()).toBe("MAINTENANCE");
    expect(() => registry.beginRegisteredOperation(crypto.randomUUID(), "mutation")).toThrow("draining");
    registry.leaveMaintenanceMode();
  });

  it("fails closed when acquired required resources have no shutdown callback", async () => {
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const events: Array<Record<string, unknown>> = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { if (args[0] === "shutdown_event" && typeof args[1] === "string") events.push(JSON.parse(args[1])); });
    const coordinator = (globalThis as typeof globalThis & Record<symbol, { ownershipAcquired?: boolean }>)[Symbol.for("multiagents.lifecycle-coordinator.v1")]!;
    coordinator.ownershipAcquired = true;
    configureShutdownRuntime({ resources: { httpListening: true, nextPrepared: true }, stopAcceptingHttp: () => undefined });
    const result = await finalizeServerShutdown(100);
    expect(events.some((event) => event.phase === "http_close_failed")).toBe(true);
    expect(events.some((event) => event.phase === "next_close_failed")).toBe(true);
    expect(events.some((event) => event.phase === "ownership_release_failed")).toBe(true);
    expect(events.some((event) => event.phase === "http_close_skipped")).toBe(false);
    expect(result.success).toBe(false); expect(result.errors.length).toBeGreaterThanOrEqual(3);
    info.mockRestore(); coordinator.ownershipAcquired = false;
    const reset = coordinator as { shutdown?: unknown; shutdownId?: unknown; runtime?: unknown }; reset.shutdown = undefined; reset.shutdownId = undefined; reset.runtime = undefined;
  });

  it("reports a persisted unreconciled journal row and continues cleanup after an entry failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-phase21e3-journal-")); const database = join(root, "state.db");
    const store = new StateStore(database); replaceStateStoreForTests(store);
    const first = store.createOperation({ type: "git_push", idempotencyKey: `git_push:${crypto.randomUUID()}` });
    const second = store.createOperation({ type: "git_push", idempotencyKey: `git_push:${crypto.randomUUID()}` });
    store.updateOperation(first.operationId, "executing"); store.updateOperation(second.operationId, "executing");
    const update = store.updateOperation.bind(store); let failFirst = true;
    vi.spyOn(store, "updateOperation").mockImplementation(((operationId: string, state: never, details?: never, errorCode?: never) => {
      if (operationId === first.operationId && failFirst) { failFirst = false; throw new Error("fixture journal update failure"); }
      return update(operationId, state, details, errorCode);
    }) as typeof store.updateOperation);
    const events: Array<Record<string, unknown>> = []; const release = vi.fn(async () => ({ status: "released" as const }));
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { if (args[0] === "shutdown_event" && typeof args[1] === "string") events.push(JSON.parse(args[1])); });
    const coordinator = (globalThis as typeof globalThis & Record<symbol, { lease?: unknown }>)[Symbol.for("multiagents.lifecycle-coordinator.v1")]!;
    coordinator.lease = { release };
    configureShutdownRuntime({ stopAcceptingHttp: () => undefined, closeHttp: () => undefined, closeNext: () => undefined });
    const result = await finalizeServerShutdown(100);
    const verified = new StateStore(database).loadUnfinishedOperations();
    const journal = events.find((event) => event.phase === "journal_reconcile_failed");
    expect(journal).toMatchObject({ unfinishedOperationsBefore: 2, unfinishedOperationsAfter: 1, attempted: 2, succeeded: 1, failed: 1, remaining: 1 });
    expect(events.some((event) => event.phase === "journal_reconcile_completed")).toBe(false);
    expect(events.some((event) => event.phase === "state_close_completed")).toBe(true);
    expect(events.some((event) => event.phase === "http_close_completed")).toBe(true);
    expect(events.some((event) => event.phase === "next_close_completed")).toBe(true);
    expect(events.some((event) => event.phase === "ownership_release_completed")).toBe(true);
    expect(release).toHaveBeenCalledOnce(); expect(result.success).toBe(false); expect(result.errors).toHaveLength(1);
    expect(verified.filter((operation) => operation.state !== "reconcile_required")).toHaveLength(1);
    info.mockRestore(); coordinator.lease = undefined;
    (coordinator as { shutdown?: unknown; shutdownId?: unknown; runtime?: unknown }).shutdown = undefined;
    (coordinator as { shutdown?: unknown; shutdownId?: unknown; runtime?: unknown }).shutdownId = undefined;
    (coordinator as { shutdown?: unknown; shutdownId?: unknown; runtime?: unknown }).runtime = undefined;
  });

  it("flushes shutdown state by closing the database", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-phase196-lock-"));
    const store = new StateStore(join(root, "state.db")); replaceStateStoreForTests(store);
    const events: Array<Record<string, unknown>> = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      if (args[0] === "shutdown_event" && typeof args[1] === "string") events.push(JSON.parse(args[1]));
    });
    configureShutdownRuntime({ stopAcceptingHttp: () => undefined, cleanupRuntime: () => undefined, closeHttp: () => undefined, closeNext: () => undefined });
    const result = await finalizeServerShutdown(100);
    const phases = events.map((event) => String(event.phase));
    const ordered = ["shutdown_started", "mutation_gate_closed", "child_drain_completed", "journal_reconcile_completed", "state_close_completed", "runtime_cleanup_completed", "http_close_completed", "next_close_completed", "ownership_release_started", "ownership_release_skipped", "shutdown_completed"];
    for (let index = 1; index < ordered.length; index++) expect(phases.indexOf(ordered[index - 1]!)).toBeLessThan(phases.indexOf(ordered[index]!));
    for (const phase of ["shutdown_started", "child_drain_started", "state_close_started", "ownership_release_started", "ownership_release_skipped", "shutdown_completed"]) expect(phases.filter((item) => item === phase)).toHaveLength(1);
    expect(new Set(events.map((event) => event.shutdownId))).toEqual(new Set([result.shutdownId]));
    expect(result.success).toBe(true);
    info.mockRestore();
    expect(() => store.schemaVersion()).toThrow();
  });

  it("kills a real detached process group including its background descendant", async () => {
    const source = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(c.pid)+'\\n'); setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const descendantPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture did not start")), 2_000);
      child.stdout.once("data", (chunk: Buffer) => { clearTimeout(timer); resolve(Number(chunk.toString("utf8").trim())); });
      child.once("error", reject);
    });
    registerChildProcess({ child, purpose: "other" });
    await terminateRegisteredChildren({ graceMs: 500 });
    expect(activeChildProcesses()).toEqual([]);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });
});
