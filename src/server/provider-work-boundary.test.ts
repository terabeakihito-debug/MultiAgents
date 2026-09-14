import { describe, expect, it, vi } from "vitest";
import { createAgentAdapter } from "../agents/runner";
import { buildGenericRuntimePolicy } from "./runtime-policy";
import { notifyProviderWorkStart, withProviderWorkBoundary } from "./provider-work-boundary";

describe("provider work boundary", () => {
  it("notifies exactly once inside one provider execution context", () => {
    const callback = vi.fn();
    withProviderWorkBoundary(callback, () => {
      notifyProviderWorkStart();
      notifyProviderWorkStart();
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not notify outside a provider execution context", () => {
    const callback = vi.fn();
    notifyProviderWorkStart();
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps nested provider executions isolated", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    withProviderWorkBoundary(outer, () => {
      withProviderWorkBoundary(inner, () => notifyProviderWorkStart());
      notifyProviderWorkStart();
    });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("production runner signals the boundary synchronously before provider spawn", async () => {
    const boundary = vi.fn();
    const spawnProcess = vi.fn(() => {
      expect(boundary).toHaveBeenCalledTimes(1);
      throw new Error("intentional spawn stop");
    });
    const adapter = createAgentAdapter({
      id: "codex",
      name: "Codex",
      binary: "codex",
      args: () => ["exec", "prompt"],
    }, { spawnProcess, unsafeTestOnlyBypassOsSandbox: true });

    const result = await withProviderWorkBoundary(boundary, () => adapter.run("prompt", {
      policy: buildGenericRuntimePolicy("codex", "/tmp/provider-work-boundary"),
    }));

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "error", error: "intentional spawn stop" });
  });

  it("does not spawn when the provider-work boundary rejects execution", async () => {
    const spawnProcess = vi.fn(() => { throw new Error("must not spawn"); });
    const adapter = createAgentAdapter({
      id: "codex",
      name: "Codex",
      binary: "codex",
      args: () => ["exec", "prompt"],
    }, { spawnProcess, unsafeTestOnlyBypassOsSandbox: true });

    const result = await withProviderWorkBoundary(() => false, () => adapter.run("prompt", {
      policy: buildGenericRuntimePolicy("codex", "/tmp/provider-work-boundary"),
    }));

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error", error: "Provider work budget exhausted before spawn" });
  });
});
