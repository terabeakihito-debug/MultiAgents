import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { probeAbstractUnixSocketCapability, reportUnavailableAbstractUnixSocketCapability, type AbstractUnixSocketServer } from "./abstract-unix-socket-capability";

class FakeServer extends EventEmitter implements AbstractUnixSocketServer {
  listening = false;
  readonly listen = vi.fn(() => this);
  readonly close = vi.fn((callback: (error?: Error) => void) => { this.listening = false; callback(); return this; });

  succeedListen() { this.listening = true; this.emit("listening"); }
  failListen(code: string) {
    const error = Object.assign(new Error(`listen ${code}`), { code });
    this.emit("error", error);
  }
}

const dependencies = (server: FakeServer, platform: NodeJS.Platform = "linux") => ({
  platform, createServer: () => server, randomUUID: () => "fixed-uuid", geteuid: () => 1000,
});

describe("abstract Unix socket test-host capability probe", () => {
  it("reports available on Linux after listening and closing exactly once", async () => {
    const server = new FakeServer();
    server.listen.mockImplementation(() => { queueMicrotask(() => server.succeedListen()); return server; });
    await expect(probeAbstractUnixSocketCapability(dependencies(server))).resolves.toEqual({ available: true });
    expect(server.listen).toHaveBeenCalledWith({ path: "\0multiagents-test-abstract-uds-probe-1000-fixed-uuid", exclusive: true });
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
    expect(server.listenerCount("listening")).toBe(0);
    expect(server.listenerCount("error")).toBe(0);
  });

  it("reports non-Linux hosts explicitly without creating a listener", async () => {
    const server = new FakeServer();
    await expect(probeAbstractUnixSocketCapability(dependencies(server, "darwin"))).resolves.toEqual({ available: false, reason: "platform_not_linux" });
    expect(server.listen).not.toHaveBeenCalled();
  });

  it("reports a fixed unavailable reason for gated test output", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      reportUnavailableAbstractUnixSocketCapability({ available: false, reason: "eperm" });
      expect(warn).toHaveBeenCalledWith("test_host_capability_unavailable", "{\"capability\":\"linux_abstract_unix_socket\",\"reason\":\"eperm\"}");
    } finally { warn.mockRestore(); }
  });

  for (const code of ["EPERM", "EACCES", "ENOSYS", "EAFNOSUPPORT", "EPROTONOSUPPORT", "EOPNOTSUPP", "ENOTSUP"]) {
    it(`reports ${code} as unavailable`, async () => {
      const server = new FakeServer();
      server.listen.mockImplementation(() => { queueMicrotask(() => server.failListen(code)); return server; });
      await expect(probeAbstractUnixSocketCapability(dependencies(server))).resolves.toEqual({ available: false, reason: code.toLowerCase() });
      expect(server.listenerCount("listening")).toBe(0);
      expect(server.listenerCount("error")).toBe(0);
      expect(server.close).not.toHaveBeenCalled();
    });
  }

  for (const code of ["EADDRINUSE", "EINVAL", "EMFILE", "ENFILE", "ENOMEM", "UNKNOWN"]) {
    it(`fails instead of masking ${code}`, async () => {
      const server = new FakeServer();
      server.listen.mockImplementation(() => { queueMicrotask(() => server.failListen(code)); return server; });
      await expect(probeAbstractUnixSocketCapability(dependencies(server))).rejects.toMatchObject({ code });
    });
  }

  it("fails when close fails after a successful listen", async () => {
    const server = new FakeServer();
    server.listen.mockImplementation(() => { queueMicrotask(() => server.succeedListen()); return server; });
    server.close.mockImplementation((callback) => { callback(new Error("close failed")); return server; });
    await expect(probeAbstractUnixSocketCapability(dependencies(server))).rejects.toThrow("close failed");
    expect(server.close).toHaveBeenCalledOnce();
  });
});
