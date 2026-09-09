import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAgentExecutionAdmissible, captureUnresolvedAgentExecution, hasUnconfirmedAgentExecution, inspectUnresolvedAgentProcess, quarantineUnconfirmedAgentExecution, reconcileUnconfirmedAgentExecutions, restoreDurableUnconfirmedAgentExecutions } from "./agent-execution-guard";
import { StateStore, replaceStateStoreForTests } from "./state-store";

type GuardGlobal = typeof globalThis & { __multiAgentsUnconfirmedExecutions?: Map<string, unknown>; __multiAgentsUnresolvedRestoreState?: "NOT_STARTED" | "RESTORING" | "READY" | "FAILED"; __multiAgentsActiveExecutions?: number };
const shared = globalThis as GuardGlobal;

afterEach(() => {
  shared.__multiAgentsUnconfirmedExecutions?.clear();
  shared.__multiAgentsUnresolvedRestoreState = "READY";
  shared.__multiAgentsActiveExecutions = 0;
  replaceStateStoreForTests(new StateStore(":memory:"));
  vi.restoreAllMocks();
});
beforeEach(() => { shared.__multiAgentsUnresolvedRestoreState = "NOT_STARTED"; });

describe("durable unresolved-agent ownership", () => {
  it("restores quarantine before admission when an old process group remains unconfirmed", async () => {
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    store.saveUnresolvedAgentProcess({ executionId: "11111111-1111-4111-8111-111111111111", provider: "cursor", pid: 999999, pgid: 4242, leaderStartTicks: "1", createdAt: new Date().toISOString(), phase: "UNCONFIRMED" });
    await restoreDurableUnconfirmedAgentExecutions();
    expect(hasUnconfirmedAgentExecution()).toBe(true);
    expect(() => assertAgentExecutionAdmissible()).toThrow("unresolved_agent_process");
    expect(store.loadUnresolvedAgentProcesses()).toHaveLength(1);
  });

  it("never signals a reused PID whose Linux start identity does not match", async () => {
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const kill = vi.spyOn(process, "kill");
    store.saveUnresolvedAgentProcess({ executionId: "22222222-2222-4222-8222-222222222222", provider: "cursor", pid: process.pid, pgid: 4242, leaderStartTicks: "1", createdAt: new Date().toISOString(), phase: "UNCONFIRMED" });
    await restoreDurableUnconfirmedAgentExecutions();
    expect(kill).not.toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
    expect(hasUnconfirmedAgentExecution()).toBe(false);
    expect(store.loadUnresolvedAgentProcesses()).toEqual([]);
  });

  it("retries a failed durable restore and keeps admission fail-closed until READY", async () => {
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const load = vi.spyOn(store, "loadUnresolvedAgentProcesses").mockImplementationOnce(() => { throw new Error("read failed"); }).mockReturnValue([]);
    await expect(restoreDurableUnconfirmedAgentExecutions()).rejects.toThrow("read failed");
    expect(() => assertAgentExecutionAdmissible()).toThrow("unresolved_agent_restore_not_ready");
    await restoreDurableUnconfirmedAgentExecutions();
    expect(load).toHaveBeenCalledTimes(2);
    expect(() => assertAgentExecutionAdmissible()).not.toThrow();
  });

  it("retains durable ownership when reconciliation state persistence fails", async () => {
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const record = { executionId: "33333333-3333-4333-8333-333333333333", provider: "cursor" as const, pid: process.pid, pgid: 4242, leaderStartTicks: "1", createdAt: new Date().toISOString(), phase: "UNCONFIRMED" as const };
    store.saveUnresolvedAgentProcess(record);
    vi.spyOn(store, "updateUnresolvedAgentProcessPhase").mockImplementation(() => { throw new Error("db update failed"); });
    await restoreDurableUnconfirmedAgentExecutions();
    await reconcileUnconfirmedAgentExecutions();
    expect(hasUnconfirmedAgentExecution()).toBe(true);
    expect(store.loadUnresolvedAgentProcesses()).toHaveLength(1);
  });

  it("keeps a durably quarantined live group unresolved until a later confirmed termination", async () => {
    const store = new StateStore(":memory:"); replaceStateStoreForTests(store);
    const captured = captureUnresolvedAgentExecution({ provider: "cursor", pid: process.pid });
    const record = { ...captured, phase: "UNCONFIRMED" as const };
    store.saveUnresolvedAgentProcess(record);
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    await restoreDurableUnconfirmedAgentExecutions();
    await reconcileUnconfirmedAgentExecutions();
    expect(inspectUnresolvedAgentProcess(record)).toBe("ALIVE");
    expect(hasUnconfirmedAgentExecution()).toBe(true);
    expect(store.loadUnresolvedAgentProcesses()).toMatchObject([{ executionId: record.executionId, phase: "UNCONFIRMED" }]);
    expect(() => assertAgentExecutionAdmissible()).toThrow("unresolved_agent_process");

    kill.mockImplementation((() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }) as typeof process.kill);
    await reconcileUnconfirmedAgentExecutions();
    expect(hasUnconfirmedAgentExecution()).toBe(false);
    expect(store.loadUnresolvedAgentProcesses()).toEqual([]);
  });

  it("treats unknown and inspection failures as non-terminal", () => {
    const record = { pid: process.pid, pgid: 4242, leaderStartTicks: "not-this-process" };
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    expect(inspectUnresolvedAgentProcess(record)).toBe("UNKNOWN");
    kill.mockImplementation((() => { throw new Error("inspection unavailable"); }) as typeof process.kill);
    expect(inspectUnresolvedAgentProcess(record)).toBe("INSPECTION_FAILED");
  });

  it("retries both synchronous throws and asynchronous rejections without overlap", async () => {
    await restoreDurableUnconfirmedAgentExecutions();
    let syncAttempts = 0;
    quarantineUnconfirmedAgentExecution({ reconcile: () => { syncAttempts++; throw new Error("sync"); } });
    await reconcileUnconfirmedAgentExecutions();
    await reconcileUnconfirmedAgentExecutions();
    expect(syncAttempts).toBe(2);

    shared.__multiAgentsUnconfirmedExecutions?.clear();
    let asyncAttempts = 0;
    quarantineUnconfirmedAgentExecution({ reconcile: async () => { asyncAttempts++; throw new Error("async"); } });
    await reconcileUnconfirmedAgentExecutions();
    await reconcileUnconfirmedAgentExecutions();
    expect(asyncAttempts).toBe(2);

    shared.__multiAgentsUnconfirmedExecutions?.clear();
    let calls = 0; let release!: () => void;
    quarantineUnconfirmedAgentExecution({ reconcile: async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); } });
    const first = reconcileUnconfirmedAgentExecutions();
    const second = reconcileUnconfirmedAgentExecutions();
    const third = reconcileUnconfirmedAgentExecutions();
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second, third]);
    const fourth = reconcileUnconfirmedAgentExecutions();
    await Promise.resolve();
    expect(calls).toBe(2);
    release();
    await fourth;
  });
});
