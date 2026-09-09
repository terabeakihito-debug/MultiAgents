import { afterEach, describe, expect, it, vi } from "vitest";

describe("operational startup ownership invariant", () => {
  afterEach(() => {
    vi.doUnmock("./server-lifecycle"); vi.doUnmock("./operational-health"); vi.doUnmock("./tasks"); vi.doUnmock("./provider-diagnostics"); vi.resetModules();
  });

  it("rejects an async startup completion after its lease was aborted", async () => {
    let active = true, continueRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { continueRecovery = resolve; });
    const held = { instanceId: "lease-a", isActive: () => active };
    const abort = vi.fn(async () => { active = false; });
    vi.doMock("./server-lifecycle", () => ({
      installServerLifecycle: vi.fn(async () => held), abortServerStartup: abort,
      hasActiveServerOwnershipLease: () => active,
      assertActiveServerOwnership: (expected: typeof held) => { if (!active || expected !== held) throw new Error("Server ownership lease is not active; restart required"); },
    }));
    vi.doMock("./operational-health", () => ({ databaseReadiness: vi.fn() }));
    vi.doMock("./tasks", () => ({ initializeTaskRecovery: () => recovery }));
    vi.doMock("./provider-diagnostics", () => ({ providerDiagnostics: vi.fn(async () => undefined) }));
    const startup = await import("./operational-startup");
    const attempt = startup.initializeOperationalStartup(); await new Promise((resolve) => setImmediate(resolve));
    await abort(); continueRecovery();
    await expect(attempt).rejects.toThrow("ownership lease is not active");
  });

  it("invalidates cached RUNNING immediately when ownership is lost", async () => {
    let lost!: () => void, active = true;
    const held = { instanceId: "lease-b" };
    vi.doMock("./server-ownership-events", () => ({ onServerOwnershipLost: (listener: () => void) => { lost = listener; return () => undefined; } }));
    vi.doMock("./server-lifecycle", () => ({
      installServerLifecycle: vi.fn(async () => { if (!active) throw new Error("restart required"); return held; }), abortServerStartup: vi.fn(),
      hasActiveServerOwnershipLease: () => active, assertActiveServerOwnership: () => { if (!active) throw new Error("restart required"); },
    }));
    vi.doMock("./operational-health", () => ({ databaseReadiness: vi.fn() }));
    vi.doMock("./tasks", () => ({ initializeTaskRecovery: vi.fn(async () => undefined) }));
    vi.doMock("./provider-diagnostics", () => ({ providerDiagnostics: vi.fn(async () => undefined) }));
    const startup = await import("./operational-startup");
    await startup.initializeOperationalStartup();
    active = false;
    lost();
    await expect(startup.initializeOperationalStartup()).rejects.toThrow("restart required");
  });
});
