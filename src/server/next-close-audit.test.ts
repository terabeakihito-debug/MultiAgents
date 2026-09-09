import next from "next";
import { describe, expect, it } from "vitest";

type FakeCustomServer = {
  init?: {
    server: { close: () => Promise<void>; onServerClose: (callback: () => Promise<void>) => void };
    cleanupListeners?: { runAll: () => Promise<void> };
  };
  close: () => Promise<void>;
};

describe("Next custom-server cleanup audit", () => {
  it("detects a rejected registered cleanup even though installed Next app.close resolves", async () => {
    // @ts-expect-error JavaScript launcher helper is intentionally shared with server.mjs.
    const { installNextCloseAudit } = await import("./next-close-audit.mjs");
    const app = next({ dev: false }) as unknown as FakeCustomServer;
    let cleanup: (() => Promise<void>) | undefined;
    app.init = { server: { onServerClose: (callback: () => Promise<void>) => { cleanup = callback; }, close: async () => { await cleanup?.(); } }, cleanupListeners: { runAll: async () => undefined } };
    const audit = installNextCloseAudit(app);
    audit.register("rejecting_callback", async () => { throw new Error("fixture cleanup rejection"); });
    await expect(app.close()).resolves.toBeUndefined();
    expect(() => audit.assertSucceeded()).toThrow("next_framework_cleanup_failed");
  });

  it("fails when installed Next close resolves without invoking a required callback", async () => {
    // @ts-expect-error JavaScript launcher helper is intentionally shared with server.mjs.
    const { installNextCloseAudit } = await import("./next-close-audit.mjs");
    const app = next({ dev: false }) as unknown as FakeCustomServer;
    app.init = { server: { onServerClose: () => undefined, close: async () => { throw new Error("inner close failed before callbacks"); } }, cleanupListeners: { runAll: async () => undefined } };
    const audit = installNextCloseAudit(app);
    audit.register("never_invoked", async () => undefined);
    await expect(app.close()).resolves.toBeUndefined();
    expect(audit.snapshot()).toMatchObject([{ name: "never_invoked", started: false, completed: false, failed: false }]);
    expect(() => audit.assertSucceeded()).toThrow("next_framework_cleanup_incomplete");
  });
});
