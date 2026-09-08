import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeChildProcesses, registerChildProcess, resetChildProcessRegistryForTests, terminateRegisteredChildren } from "./child-process-registry";
import { StateStore, replaceStateStoreForTests } from "./state-store";
import { drainForMaintenance, finalizeShutdownForTests, gracefulDrainForTests } from "./server-lifecycle";
import { beginRegisteredOperation, leaveMaintenanceMode, lifecycleState, resetOperationRegistryForTests } from "./operation-registry";

function fakeChild(pid = 42) {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  Object.defineProperty(child, "pid", { value: pid });
  child.kill = vi.fn();
  return child as ChildProcess;
}

afterEach(() => {
  resetChildProcessRegistryForTests();
  resetOperationRegistryForTests();
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
    await gracefulDrainForTests(100);
    expect(store.loadOperation(operation.operationId)).toMatchObject({ state: "reconcile_required", errorCode: "shutdown_child_terminated" });
  });

  it("stops a delayed GitHub-create mock before it can report success and leaves PR recovery manual", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-phase196-gh-")); const marker = join(root, "pr-created");
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const operation = store.createOperation({ type: "pr_create", idempotencyKey: `pr_create:${crypto.randomUUID()}` }); store.updateOperation(operation.operationId, "executing");
    const source = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'created'), 1000); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: "ignore" });
    registerChildProcess({ child, purpose: "github", operationId: operation.operationId });
    await gracefulDrainForTests(500);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.loadOperation(operation.operationId)).toMatchObject({ state: "reconcile_required", errorCode: "shutdown_child_terminated" });
  });

  it("applies the same termination policy before maintenance mode remains draining", async () => {
    const child = fakeChild(666); registerChildProcess({ child, purpose: "agent" });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: NodeJS.Signals) => {
      if (pid === -666 && signal === "SIGTERM") child.emit("close", null, "SIGTERM");
      return true;
    }) as typeof process.kill);
    await drainForMaintenance(100);
    expect(lifecycleState()).toBe("DRAINING");
    expect(() => beginRegisteredOperation(crypto.randomUUID(), "mutation")).toThrow("draining");
    leaveMaintenanceMode();
  });

  it("flushes shutdown state by closing the database and removing the server lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-phase196-lock-"));
    const store = new StateStore(join(root, "state.db")); replaceStateStoreForTests(store);
    const lock = join(root, "server.lock"); await writeFile(lock, "fixture\n", { mode: 0o600 });
    await finalizeShutdownForTests(100, lock);
    await expect(import("node:fs/promises").then(({ lstat }) => lstat(lock))).rejects.toMatchObject({ code: "ENOENT" });
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
