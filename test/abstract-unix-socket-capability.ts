import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

export type AbstractUnixSocketServer = Pick<EventEmitter, "off" | "once"> & {
  readonly listening: boolean;
  listen: (options: { path: string; exclusive: true }) => unknown;
  close: (callback: (error?: Error) => void) => unknown;
};
export type AbstractUnixSocketCapabilityDependencies = {
  platform?: NodeJS.Platform;
  createServer?: () => AbstractUnixSocketServer;
  randomUUID?: () => string;
  geteuid?: () => number;
};
export type AbstractUnixSocketCapability =
  | { available: true }
  | { available: false; reason: string };

const unavailableCodes = new Set([
  "EPERM", "EACCES", "ENOSYS", "EAFNOSUPPORT", "EPROTONOSUPPORT", "EOPNOTSUPP", "ENOTSUP",
]);

/**
 * Test-host-only probe for Linux abstract Unix-domain socket support.
 * It deliberately uses a random abstract name rather than the production
 * ownership key, and is never imported by production code.
 */
export async function probeAbstractUnixSocketCapability(
  dependencies: AbstractUnixSocketCapabilityDependencies = {},
): Promise<AbstractUnixSocketCapability> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "linux") return { available: false, reason: "platform_not_linux" };
  const server = (dependencies.createServer ?? (() => net.createServer()))();
  const uid = (dependencies.geteuid ?? process.geteuid)?.() ?? "unknown";
  const name = `\0multiagents-test-abstract-uds-probe-${uid}-${(dependencies.randomUUID ?? randomUUID)()}`;

  try {
    await listen(server, name);
  } catch (error) {
    if (server.listening) await close(server);
    const code = errorCode(error);
    if (code && unavailableCodes.has(code)) return { available: false, reason: code.toLowerCase() };
    throw error;
  }

  await close(server);
  if (server.listening) throw new Error("Abstract Unix socket capability probe listener remained active after close");
  return { available: true };
}

/** Leaves a fixed, content-free reason beside gated test suites in CI logs. */
export function reportUnavailableAbstractUnixSocketCapability(capability: AbstractUnixSocketCapability) {
  if (capability.available) return;
  console.warn("test_host_capability_unavailable", JSON.stringify({ capability: "linux_abstract_unix_socket", reason: capability.reason }));
}

function listen(server: AbstractUnixSocketServer, path: string) {
  return new Promise<void>((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      server.off("listening", ready);
      server.off("error", failed);
    };
    server.once("listening", ready);
    server.once("error", failed);
    try { server.listen({ path, exclusive: true }); }
    catch (error) { failed(error instanceof Error ? error : new Error("Abstract Unix socket capability probe listen failed")); }
  });
}

function close(server: AbstractUnixSocketServer) {
  return new Promise<void>((resolve, reject) => {
    try { server.close((error) => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
  });
}

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
