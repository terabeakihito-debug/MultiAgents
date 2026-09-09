import { randomUUID } from "node:crypto";
import net from "node:net";
import { getServerOwnershipSocketName } from "./server-ownership-socket.mjs";

// Linux abstract UDS names start with a NUL byte and never name a filesystem
// object. WSL2 reports `linux` and uses the same kernel namespace.
// Keep module loading fail-closed on unsupported hosts; acquisition itself
// checks the platform before asking the host for an effective UID.
export const SERVER_INSTANCE_SOCKET_NAME = process.platform === "linux" ? getServerOwnershipSocketName() : "\0multiagents-server-v1-unsupported";
export type ReleaseResult = { status: "released" | "alreadyReleased" | "error" };
export type ServerInstanceLease = Readonly<{
  instanceId: string;
  nonce: string;
  generation: string;
  acquiredAt: string;
  server: net.Server;
  isActive: () => boolean;
  release: () => Promise<ReleaseResult>;
}>;
type Options = { onOwnershipLost?: (error?: Error) => void };

export class ServerInstanceLockedError extends Error {
  constructor(message = "Another MultiAgents server instance owns the runtime lock") { super(message); this.name = "ServerInstanceLockedError"; }
}
export class ServerInstanceUnsupportedPlatformError extends Error {
  constructor() { super("Server instance ownership requires Linux abstract Unix domain sockets"); this.name = "ServerInstanceUnsupportedPlatformError"; }
}

/** The live kernel socket bind is the sole server-instance ownership authority. */
export async function acquireServerInstanceLock(options: Options = {}): Promise<ServerInstanceLease> {
  if (process.platform !== "linux") throw new ServerInstanceUnsupportedPlatformError();
  const server = net.createServer();
  try { await listen(server, getServerOwnershipSocketName()); }
  catch (error) {
    try { server.close(); } catch { /* it never became active */ }
    if (isAddressInUse(error)) throw new ServerInstanceLockedError();
    throw error;
  }

  const instanceId = randomUUID();
  let ownershipActive = true, releaseStarted = false, socketClosed = false, lossReported = false, releasePromise: Promise<ReleaseResult> | undefined;
  let settleClose!: () => void;
  const closeSettled = new Promise<void>((resolve) => { settleClose = resolve; });
  const ownershipLost = (error?: Error) => {
    if (lossReported || releaseStarted) return;
    lossReported = true;
    ownershipActive = false;
    options.onOwnershipLost?.(error);
  };
  server.on("close", () => { socketClosed = true; ownershipLost(); settleClose(); });
  server.on("error", ownershipLost);
  return Object.freeze({
    instanceId,
    nonce: instanceId,
    generation: instanceId,
    acquiredAt: new Date().toISOString(),
    server,
    isActive: () => ownershipActive && !socketClosed && server.listening,
    release: () => releasePromise ??= (async () => {
      if (socketClosed) return { status: "alreadyReleased" as const };
      // A non-listening server without its close event is an already-started,
      // unexpected close. Await its finalizer before deciding the outcome.
      if (!server.listening) { await closeSettled; return { status: "alreadyReleased" as const }; }
      releaseStarted = true;
      server.close();
      await closeSettled;
      ownershipActive = false;
      return { status: "released" as const };
    })(),
  });
}

function listen(server: net.Server, path: string) {
  return new Promise<void>((resolve, reject) => {
    const ready = () => { server.off("error", failed); resolve(); };
    const failed = (error: Error) => { server.off("listening", ready); reject(error); };
    server.once("listening", ready);
    server.once("error", failed);
    // No reusePort/reuse semantics: bind is exclusive in the kernel namespace.
    server.listen({ path, exclusive: true });
  });
}

function isAddressInUse(error: unknown) { return error instanceof Error && "code" in error && error.code === "EADDRINUSE"; }
