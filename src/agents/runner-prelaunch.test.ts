import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { activeChildProcesses } from "../server/child-process-registry";
import { hasUnconfirmedAgentExecution, isAgentExecutionActive, isOrdinaryAgentExecutionActive, quarantineUnconfirmedAgentExecution } from "../server/agent-execution-guard";

const controls = vi.hoisted(() => ({
  provider: async () => ({ identity: "fixture", status: "supported" }),
  identity: async () => ({ identity: "fixture" }),
  binding: async () => ({ cleanup: async () => undefined }),
  sandbox: async () => undefined,
}));

vi.mock("../server/provider-diagnostics", () => ({
  assertProviderExecutionAllowed: () => controls.provider(),
  assertProviderExecutionIdentity: () => controls.identity(),
  prepareProviderImmutableBinding: () => controls.binding(),
}));
vi.mock("../server/os-sandbox", async () => ({
  ...await vi.importActual<typeof import("../server/os-sandbox")>("../server/os-sandbox"),
  assertOsSandboxAvailable: () => controls.sandbox(),
  buildSandboxCommand: () => ({ binary: "fixture", args: [], cwd: "/", env: {}, sandboxCwd: "/project" }),
}));

import { createAgentAdapter } from "./runner";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 424242; child.kill = vi.fn(() => true);
  return child;
}
function adapter(child?: ReturnType<typeof fakeChild> | ChildProcess) {
  return createAgentAdapter(
    { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
    child ? { spawnProcess: vi.fn(() => child) as never } : undefined,
  );
}
async function waitForSpawn(child: ReturnType<typeof fakeChild>) {
  for (let index = 0; index < 12 && child.listenerCount("close") === 0; index += 1) await Promise.resolve();
  expect(child.listenerCount("close")).toBeGreaterThan(0);
}

afterEach(() => {
  controls.provider = async () => ({ identity: "fixture", status: "supported" });
  controls.identity = async () => ({ identity: "fixture" });
  controls.binding = async () => ({ cleanup: async () => undefined });
  controls.sandbox = async () => undefined;
});

describe("pre-launch settlement", () => {
  it("acquires final admission before spawn when quarantine appears during preparation", async () => {
    const child = fakeChild();
    let releasePreparation!: () => void;
    controls.provider = () => new Promise((resolve) => { releasePreparation = () => resolve({ identity: "fixture", status: "supported" }); });
    let cleanup = 0;
    controls.binding = async () => ({ cleanup: async () => { cleanup++; } });
    const spawnProcess = vi.fn(() => child);
    const pending = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { spawnProcess: spawnProcess as never },
    ).run("review");
    await Promise.resolve();
    const quarantine = quarantineUnconfirmedAgentExecution();
    try {
      releasePreparation();
      await expect(pending).resolves.toMatchObject({ status: "error", error: "unresolved_agent_process" });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(cleanup).toBe(1);
      expect(activeChildProcesses()).toEqual([]);
      expect(child.listenerCount("close")).toBe(0);
      expect(hasUnconfirmedAgentExecution()).toBe(true);
    } finally { quarantine.release(); }
  });

  it.each([
    ["sandbox", () => { controls.sandbox = async () => { throw new Error("sandbox preparation failed"); }; }, "sandbox preparation failed"],
    ["immutable runtime", () => { controls.binding = async () => { throw new Error("immutable preparation failed"); }; }, "immutable preparation failed"],
  ])("settles the primary %s failure when an async audit rejects", async (_name, arrange, expected) => {
    arrange();
    let settled = 0;
    await expect(adapter().run("review", { onSandboxAudit: async () => { throw new Error("audit persistence failed"); } }).then((result) => { settled++; return result; }))
      .resolves.toMatchObject({ status: "error", error: expected });
    expect(settled).toBe(1);
    expect(activeChildProcesses()).toEqual([]);
    expect(isAgentExecutionActive()).toBe(false);
  });

  it("routes listener setup failure through close, verification, and immutable cleanup", async () => {
    const child = fakeChild();
    child.stdout.on = vi.fn(() => { throw new Error("listener setup failed"); }) as never;
    let runtimeCleanup = 0; let verification = 0; let settled = 0;
    controls.binding = async () => ({ cleanup: async () => { runtimeCleanup++; } });
    const pending = adapter(child).run("review", { afterClose: (result) => { verification++; return result; } }).then((result) => { settled++; return result; });
    await waitForSpawn(child);
    expect(settled).toBe(0);
    expect(isAgentExecutionActive()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ status: "error", error: "listener setup failed" });
    expect(verification).toBe(1);
    expect(runtimeCleanup).toBe(1);
    expect(settled).toBe(1);
    expect(activeChildProcesses()).toEqual([]);
    expect(isAgentExecutionActive()).toBe(false);
  });

  it("survives an overridden close-listener setup failure through the common finalizer", async () => {
    const child = fakeChild();
    child.once = vi.fn(() => { throw new Error("close listener setup failed"); }) as never;
    let verification = 0; let cleanup = 0; let audits = 0; let settled = 0;
    controls.binding = async () => ({ cleanup: async () => { cleanup++; } });
    const pending = adapter(child).run("review", {
      afterClose: (result) => { verification++; return result; },
      onSandboxAudit: () => { audits++; },
    }).then((result) => { settled++; return result; });
    await waitForSpawn(child);
    expect(settled).toBe(0);
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ status: "error", error: "close listener setup failed" });
    expect(verification).toBe(1); expect(cleanup).toBe(1); expect(audits).toBe(1);
    expect(settled).toBe(1); expect(activeChildProcesses()).toEqual([]); expect(isAgentExecutionActive()).toBe(false);
  });

  it("handles abort-listener setup failure without timer TDZ or an unhandled rejection", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    controller.signal.addEventListener = vi.fn(() => { throw new Error("abort listener setup failed"); }) as never;
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    try {
      let verification = 0; let cleanup = 0; let settled = 0;
      controls.binding = async () => ({ cleanup: async () => { cleanup++; } });
      const pending = adapter(child).run("review", { signal: controller.signal, afterClose: (result) => { verification++; return result; } }).then((result) => { settled++; return result; });
      await waitForSpawn(child);
      child.emit("close", null, "SIGTERM");
      await expect(pending).resolves.toMatchObject({ status: "error", error: "abort listener setup failed" });
      await Promise.resolve(); await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(verification).toBe(1); expect(cleanup).toBe(1); expect(settled).toBe(1); expect(isAgentExecutionActive()).toBe(false);
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("uses TERM then KILL when child registration fails after spawn", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      child.once = vi.fn(() => { throw new Error("registry listener setup failed"); }) as never;
      let verification = 0; let cleanup = 0; let audits = 0; let settled = 0;
      controls.binding = async () => ({ cleanup: async () => { cleanup++; } });
      const pending = adapter(child).run("review", {
        afterClose: (result) => { verification++; return result; }, onSandboxAudit: () => { audits++; },
      }).then((result) => { settled++; return result; });
      await waitForSpawn(child);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(settled).toBe(0);
      child.emit("close", null, "SIGKILL");
      await expect(pending).resolves.toMatchObject({ status: "error", error: "registry listener setup failed" });
      expect(verification).toBe(1); expect(cleanup).toBe(1); expect(audits).toBe(1); expect(settled).toBe(1);
      expect(activeChildProcesses()).toEqual([]); expect(isAgentExecutionActive()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("escalates a TERM-resistant listener setup failure to KILL before close", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      child.stdout.on = vi.fn(() => { throw new Error("listener setup failed"); }) as never;
      let settled = false;
      const pending = adapter(child).run("review").then(() => { settled = true; });
      await waitForSpawn(child);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(settled).toBe(false);
      child.emit("close", null, "SIGKILL");
      await pending;
      expect(isAgentExecutionActive()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("does not treat parent exit as close when a TERM-resistant descendant retains stdout", async () => {
    const descendantSource = [
      "process.on('SIGTERM', () => {});",
      "process.send?.('ready');",
      "setInterval(() => process.stdout.write('.'), 25);",
    ].join("\n");
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });`,
      "descendant.once('message', () => console.log(descendant.pid));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", parentSource], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const line = await new Promise<string>((resolve, reject) => {
      child.stdout!.once("data", (chunk) => resolve(String(chunk).trim()));
      child.once("error", reject);
    });
    const descendantPid = Number(/^\d+/.exec(line)?.[0]);
    expect(descendantPid).toBeGreaterThan(0);
    const originalOnce = EventEmitter.prototype.once;
    let rejectMandatoryCloseObserver = true;
    let verification = 0; let cleanup = 0; let settled = 0; let closeEvents = 0;
    const kill = vi.spyOn(process, "kill");
    child.once("close", () => { closeEvents++; });
    EventEmitter.prototype.once = function patchedOnce(this: EventEmitter, ...args: never[]) {
      const [event] = args as unknown as [string | symbol];
      if (this === child && event === "close" && rejectMandatoryCloseObserver) {
        rejectMandatoryCloseObserver = false;
        throw new Error("mandatory close observer setup failed");
      }
      return Reflect.apply(originalOnce, this, args) as EventEmitter;
    } as unknown as typeof EventEmitter.prototype.once;
    try {
      controls.binding = async () => ({ cleanup: async () => { cleanup++; } });
      const pending = adapter(child).run("review", {
        afterClose: (result) => { verification++; return result; },
        onSandboxAudit: (event) => { if (event.type === "os_sandbox_process_cleanup") cleanup++; },
      }).then((result) => { settled++; return result; });
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(0);
      expect(isAgentExecutionActive()).toBe(true);
      expect(() => process.kill(descendantPid, 0)).not.toThrow();
      await expect(pending).resolves.toMatchObject({ status: "error", error: "mandatory close observer setup failed" });
      expect(kill).toHaveBeenCalledWith(-child.pid!, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-child.pid!, "SIGKILL");
      expect(closeEvents).toBe(1);
      expect(verification).toBe(1);
      // One immutable-runtime cleanup and one authoritative cleanup audit.
      expect(cleanup).toBe(2);
      expect(settled).toBe(1);
      expect(activeChildProcesses()).toEqual([]);
      expect(isAgentExecutionActive()).toBe(false);
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(descendantPid, 0); }
        catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      EventEmitter.prototype.once = originalOnce;
      kill.mockRestore();
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* fixture already gone */ }
    }
  }, 10_000);

  it("fails closed after the bounded last-resort close-observer fallback", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const originalOnce = EventEmitter.prototype.once;
    const originalOn = EventEmitter.prototype.on;
    const kill = vi.spyOn(process, "kill");
    let livenessChecks = 0;
    kill.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === -child.pid && signal === 0) {
        livenessChecks++;
        if (livenessChecks < 3) return true;
        throw Object.assign(new Error("group gone"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);
    EventEmitter.prototype.once = function noCloseOnce(this: EventEmitter, ...args: never[]) {
      if (this === child && (args as unknown as [string | symbol])[0] === "close") throw new Error("close once unavailable");
      return Reflect.apply(originalOnce, this, args) as EventEmitter;
    } as unknown as typeof EventEmitter.prototype.once;
    EventEmitter.prototype.on = function noCloseOn(this: EventEmitter, ...args: never[]) {
      if (this === child && (args as unknown as [string | symbol])[0] === "close") throw new Error("close on unavailable");
      return Reflect.apply(originalOn, this, args) as EventEmitter;
    } as unknown as typeof EventEmitter.prototype.on;
    try {
      let settled = 0;
      const pending = adapter(child).run("review").then((result) => { settled++; return result; });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toMatchObject({ status: "error", error: "close once unavailable" });
      expect(livenessChecks).toBeGreaterThanOrEqual(3);
      expect(settled).toBe(1);
      expect(activeChildProcesses()).toEqual([]);
      expect(isAgentExecutionActive()).toBe(false);
    } finally {
      EventEmitter.prototype.once = originalOnce;
      EventEmitter.prototype.on = originalOn;
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("settles an unconfirmed process while quarantine blocks later execution until reconciliation", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const originalOnce = EventEmitter.prototype.once;
    const originalOn = EventEmitter.prototype.on;
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    EventEmitter.prototype.once = function noCloseOnce(this: EventEmitter, ...args: never[]) {
      if (this === child && (args as unknown as [string | symbol])[0] === "close") throw new Error("close once unavailable");
      return Reflect.apply(originalOnce, this, args) as EventEmitter;
    } as unknown as typeof EventEmitter.prototype.once;
    EventEmitter.prototype.on = function noCloseOn(this: EventEmitter, ...args: never[]) {
      if (this === child && (args as unknown as [string | symbol])[0] === "close") throw new Error("close on unavailable");
      return Reflect.apply(originalOn, this, args) as EventEmitter;
    } as unknown as typeof EventEmitter.prototype.on;
    try {
      let cleanup = 0; let settled = 0; const audits: string[] = [];
      controls.binding = async () => ({ cleanup: async () => { cleanup++; } });
      const pending = adapter(child).run("review", { onSandboxAudit: (event) => { audits.push(event.type); } }).then((result) => { settled++; return result; });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toMatchObject({ status: "error", error: "close once unavailable", finalizationUnconfirmed: true });
      expect(settled).toBe(1);
      expect(audits).toContain("os_sandbox_finalization_unconfirmed");
      expect(cleanup).toBe(0);
      expect(isOrdinaryAgentExecutionActive()).toBe(false);
      expect(hasUnconfirmedAgentExecution()).toBe(true);
      expect(isAgentExecutionActive()).toBe(true);
      // A manual/shutdown-style reconciliation while the group is still
      // alive cannot clean runtime state or release quarantine.
      const { reconcileUnconfirmedAgentExecutions } = await import("../server/agent-execution-guard");
      await reconcileUnconfirmedAgentExecutions();
      expect(cleanup).toBe(0);
      expect(hasUnconfirmedAgentExecution()).toBe(true);
      expect(isAgentExecutionActive()).toBe(true);
      const blocked = await adapter(fakeChild()).run("later");
      expect(blocked).toMatchObject({ status: "error", error: "unresolved_agent_process" });

      kill.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === -child.pid && signal === 0) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
        return true;
      }) as typeof process.kill);
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      expect(cleanup).toBe(1);
      expect(hasUnconfirmedAgentExecution()).toBe(false);
      expect(isAgentExecutionActive()).toBe(false);
      expect(settled).toBe(1);
    } finally {
      EventEmitter.prototype.once = originalOnce;
      EventEmitter.prototype.on = originalOn;
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("makes synchronous and asynchronous cleanup-audit failure equivalent", async () => {
    for (const audit of [
      () => { throw new Error("cleanup audit failed"); },
      async () => { throw new Error("cleanup audit failed"); },
    ]) {
      const child = fakeChild();
      const pending = adapter(child).run("review", { onSandboxAudit: (event) => event.type === "os_sandbox_process_cleanup" ? audit() : undefined });
      await waitForSpawn(child);
      child.emit("close", 0, null);
      await expect(pending).resolves.toMatchObject({ status: "error", error: "cleanup audit failed" });
    }
  });

  it("preserves exit failure over synchronous and asynchronous audit failure", async () => {
    for (const audit of [
      () => { throw new Error("audit secondary"); },
      async () => { throw new Error("audit secondary"); },
    ]) {
      const child = fakeChild();
      const pending = adapter(child).run("review", { onSandboxAudit: (event) => event.type === "os_sandbox_process_cleanup" ? audit() : undefined });
      await waitForSpawn(child);
      child.emit("close", 7, null);
      await expect(pending).resolves.toMatchObject({ status: "error", error: "Process exited with code 7" });
    }
  });

  it("bounds a never-resolving authoritative audit and consumes a late rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    try {
      const child = fakeChild(); let rejectLate!: (error: Error) => void;
      const late = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
      const pending = adapter(child).run("review", { onSandboxAudit: (event) => event.type === "os_sandbox_process_cleanup" ? late : undefined });
      await waitForSpawn(child);
      child.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ status: "error", error: "Authoritative sandbox audit timed out" });
      rejectLate(new Error("late audit failure"));
      await Promise.resolve(); await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(isAgentExecutionActive()).toBe(false);
    } finally { process.off("unhandledRejection", unhandled); vi.useRealTimers(); }
  });
});
