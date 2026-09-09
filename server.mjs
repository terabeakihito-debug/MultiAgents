import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import next from "next";
import { installNextCloseAudit } from "./src/server/next-close-audit.mjs";

const dev = process.argv.includes("--dev");
const port = Number.parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOSTNAME || "127.0.0.1";
const shutdownApiKey = Symbol.for("multiagents.shutdown-api.v1");
const shutdownRuntimeKey = Symbol.for("multiagents.shutdown-runtime.v1");
const startupBridgeKey = Symbol.for("multiagents.launcher-startup.v1");
const nextCleanupAuditKey = Symbol.for("multiagents.next-cleanup-audit.v1");
const STARTUP_TIMEOUT_MS = Number.parseInt(process.env.MULTIAGENTS_STARTUP_TIMEOUT_MS || "60000", 10);

let accepting = true;
let closeStarted;
let app;
let server;
let exitStarted = false;
let shutdownId;
let startupBridge;
let nextCleanupAudit;
const runtime = {
  resources: { nextPrepared: false, httpListening: false },
  stopAcceptingHttp: () => { accepting = false; },
  closeHttp: closeHttpWithDeadline,
  closeNext: closeNextWithDeadline,
};
// Must exist before app.prepare(): instrumentation acquires ownership there.
globalThis[shutdownRuntimeKey] = runtime;

function installStartupBridge() {
  let ready, failed;
  const promise = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  // Instrumentation uses this retained object to report the one authoritative
  // operational startup promise it owns.  It is deliberately installed before
  // Next loads any server modules.
  startupBridge = {
    cancelled: false,
    ready: () => ready(),
    failed: (error) => failed(error),
    setAbort: (abort) => { startupBridge.abort = abort; },
    promise,
  };
  globalThis[startupBridgeKey] = startupBridge;
}

async function awaitOperationalStartup() {
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout after ${STARTUP_TIMEOUT_MS}ms waiting for operational initialization`)), STARTUP_TIMEOUT_MS);
    timer.unref();
  });
  try { await Promise.race([startupBridge.promise, timeout]); }
  catch (error) {
    startupBridge.cancelled = true;
    await startupBridge.abort?.();
    throw error;
  }
}

function startHttpClose() {
  if (!closeStarted) {
    closeStarted = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  return closeStarted;
}

async function closeHttpWithDeadline(remainingMs) {
  const deadline = Date.now() + remainingMs;
  const close = startHttpClose();
  const timeout = new Promise((resolve) => { const timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); timer.unref(); });
  let closeError;
  const completed = await Promise.race([close.then(() => true, (error) => { closeError = error; return false; }), timeout.then(() => false)]);
  if (!completed) {
    server.closeAllConnections();
  }
  // Neither a stuck keep-alive socket nor its close callback may hold R09
  // ownership forever. Framework closure is a distinct lifecycle phase.
  if (closeError) throw closeError;
  if (!completed) throw new Error("http_server_close_timed_out");
}

async function closeNextWithDeadline(remainingMs) {
  const deadline = Date.now() + remainingMs;
  const frameworkClosed = await Promise.race([
    app.close().then(() => true),
    new Promise((resolve) => { const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); timer.unref(); }),
  ]);
  if (!frameworkClosed) throw new Error("http_framework_close_timed_out");
  nextCleanupAudit.assertSucceeded();
}

function installNextCleanupAudit() {
  nextCleanupAudit = installNextCloseAudit(app);
  try { nextCleanupAudit.register("multiagents_next_close_barrier", async () => undefined); }
  catch { /* closeNextWithDeadline reports unavailable audit as a required failure */ }
  globalThis[nextCleanupAuditKey] = nextCleanupAudit;
}

async function signalShutdown(signal) {
  shutdownId ??= randomUUID();
  console.info("shutdown_event", JSON.stringify({ shutdownId, phase: "signal_received", signal, timestamp: new Date().toISOString() }));
  const api = globalThis[shutdownApiKey];
  if (!api?.requestShutdown) return;
  const result = await api.requestShutdown(signal, shutdownId);
  if (exitStarted) return;
  exitStarted = true;
  process.exitCode = result.success ? 0 : 1;
  // This is the sole intentional process exit decision. It runs only after
  // the shared lifecycle promise has released R09 ownership.
  console.info("shutdown_event", JSON.stringify({ shutdownId: result.shutdownId, phase: "launcher_exit", timestamp: new Date().toISOString(), exitCode: process.exitCode }));
  process.exit(process.exitCode);
}

async function main() {
  installStartupBridge();
  console.info("startup_phase", JSON.stringify({ phase: "next_prepare" }));
  app = next({ dev, hostname, port, httpServer: undefined });
  await app.prepare();
  runtime.resources.nextPrepared = true;
  installNextCleanupAudit();
  console.info("startup_phase", JSON.stringify({ phase: "operational_init" }));
  await awaitOperationalStartup();
  const handle = app.getRequestHandler();
  server = createServer((request, response) => {
    if (!accepting) { response.statusCode = 503; response.end("shutting_down"); return; }
    void handle(request, response);
  });
  // Instrumentation has completed the explicit ownership/RUNNING assertion.
  const api = globalThis[shutdownApiKey];
  if (!api?.requestShutdown) throw new Error("startup readiness failed: lifecycle shutdown bridge missing");
  process.on("SIGTERM", () => { void signalShutdown("SIGTERM"); });
  process.on("SIGINT", () => { void signalShutdown("SIGINT"); });
  // The custom launcher owns the only application signal listeners; Next is
  // embedded via its request handler rather than invoked through its CLI.
  console.info("startup_signal_listeners", JSON.stringify({ SIGTERM: process.listenerCount("SIGTERM"), SIGINT: process.listenerCount("SIGINT") }));
  console.info("startup_phase", JSON.stringify({ phase: "http_listen" }));
  await new Promise((resolve, reject) => server.listen(port, hostname, (error) => error ? reject(error) : resolve()));
  runtime.resources.httpListening = true;
  console.info("startup_ready", JSON.stringify({ hostname, port }));
  console.info(`MultiAgents listening on http://${hostname}:${port} (${dev ? "development" : "production"})`);
}

main().catch(async (error) => {
  console.error("startup_failed", JSON.stringify({ phase: server ? "http_listen" : "operational_init", reason: error instanceof Error ? error.message : "unknown" }));
  if (startupBridge) startupBridge.cancelled = true;
  try { await startupBridge?.abort?.(); } catch { /* operational startup already performs cleanup */ }
  try { await app?.close?.(); } catch { /* no HTTP server was opened */ }
  process.exitCode = 1;
});
