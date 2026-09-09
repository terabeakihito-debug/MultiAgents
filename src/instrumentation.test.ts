import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeKey = Symbol.for("multiagents.launcher-startup.v1");

describe("custom launcher instrumentation handoff", () => {
  const originalRuntime = process.env.NEXT_RUNTIME;
  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
    delete (globalThis as Record<symbol, unknown>)[bridgeKey];
    vi.doUnmock("./server/operational-startup");
    vi.resetModules();
  });

  it("reports completion only after the authoritative operational promise settles", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const ready = vi.fn();
    (globalThis as Record<symbol, unknown>)[bridgeKey] = { ready, failed: vi.fn(), setAbort: vi.fn() };
    vi.doMock("./server/operational-startup", () => ({ initializeOperationalStartup: () => pending, abortOperationalStartup: vi.fn() }));
    process.env.NEXT_RUNTIME = "nodejs";
    const instrumentation = await import("./instrumentation");
    const registration = instrumentation.register();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    finish();
    await registration;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("reports a fatal initializer failure to the launcher without leaving Next work running", async () => {
    const failed = vi.fn();
    (globalThis as Record<symbol, unknown>)[bridgeKey] = { ready: vi.fn(), failed, setAbort: vi.fn() };
    vi.doMock("./server/operational-startup", () => ({ initializeOperationalStartup: vi.fn(async () => { throw new Error("provider readiness failed"); }), abortOperationalStartup: vi.fn() }));
    process.env.NEXT_RUNTIME = "nodejs";
    const instrumentation = await import("./instrumentation");
    await expect(instrumentation.register()).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "provider readiness failed" }));
  });
});
