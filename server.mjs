import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createDaemonApiBridge } from "./src/server/daemon-api-bridge.mjs";
import { createNextStaticUiBridge } from "./src/server/next-static-ui-bridge.mjs";
import {
  assertStaticUiBuildAvailable,
  runOperationalStartupFromLauncher,
} from "./src/server/operational-startup-launcher.mjs";

const dev = process.argv.includes("--dev");
const port = Number.parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOSTNAME || "127.0.0.1";
const shutdownApiKey = Symbol.for("multiagents.shutdown-api.v1");
const shutdownRuntimeKey = Symbol.for("multiagents.shutdown-runtime.v1");
const STARTUP_TIMEOUT_MS = Number.parseInt(process.env.MULTIAGENTS_STARTUP_TIMEOUT_MS || "60000", 10);

let accepting = true;
let closeStarted;
let server;
let exitStarted = false;
let shutdownId;
let startupBridge;
const runtime = {
  resources: { httpListening: false },
  stopAcceptingHttp: () => { accepting = false; },
  closeHttp: closeHttpWithDeadline,
  closeNext: async () => undefined,
};
globalThis[shutdownRuntimeKey] = runtime;

function installStartupBridge() {
  startupBridge = {
    cancelled: false,
    setAbort: (abort) => { startupBridge.abort = abort; },
  };
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
  if (closeError) throw closeError;
  if (!completed) throw new Error("http_server_close_timed_out");
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
  console.info("shutdown_event", JSON.stringify({ shutdownId: result.shutdownId, phase: "launcher_exit", timestamp: new Date().toISOString(), exitCode: process.exitCode }));
  process.exit(process.exitCode);
}

async function awaitDirectOperationalStartup() {
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout after ${STARTUP_TIMEOUT_MS}ms waiting for operational initialization`)), STARTUP_TIMEOUT_MS);
    timer.unref();
  });
  try {
    await Promise.race([runOperationalStartupFromLauncher(startupBridge), timeout]);
  } catch (error) {
    startupBridge.cancelled = true;
    await startupBridge.abort?.();
    throw error;
  }
}

async function main() {
  installStartupBridge();
  const staticUiBridge = createNextStaticUiBridge();
  const staticUiActive = await staticUiBridge.isActive();
  assertStaticUiBuildAvailable({ staticUiActive, development: dev });

  console.info("startup_phase", JSON.stringify({ phase: "operational_init" }));
  await awaitDirectOperationalStartup();

  const daemonApiBridge = createDaemonApiBridge();
  server = createServer((request, response) => {
    if (!accepting) { response.statusCode = 503; response.end("shutting_down"); return; }
    void (async () => {
      try {
        if (await daemonApiBridge.tryHandle(request, response)) return;
      } catch (error) {
        console.error(
          "daemon_api_bridge_failed",
          error instanceof Error ? error.message : "unknown",
        );
        response.statusCode = 500;
        response.end("daemon_api_bridge_failed");
        return;
      }
      try {
        if (await staticUiBridge.tryHandle(request, response)) return;
      } catch (error) {
        console.error(
          "static_ui_bridge_failed",
          error instanceof Error ? error.message : "unknown",
        );
        response.statusCode = 500;
        response.end("static_ui_bridge_failed");
        return;
      }
      response.statusCode = 404;
      response.end("not_found");
    })();
  });
  console.info(
    "daemon_api_bridge",
    JSON.stringify({ enabled: true, mode: dev ? "development" : "production" }),
  );
  console.info(
    "static_ui_bridge",
    JSON.stringify({
      active: staticUiActive,
      mode: dev ? "development" : "production",
    }),
  );
  const api = globalThis[shutdownApiKey];
  if (!api?.requestShutdown) throw new Error("startup readiness failed: lifecycle shutdown bridge missing");
  process.on("SIGTERM", () => { void signalShutdown("SIGTERM"); });
  process.on("SIGINT", () => { void signalShutdown("SIGINT"); });
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
  process.exitCode = 1;
});
