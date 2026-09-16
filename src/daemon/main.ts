import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  initializeOperationalStartup,
} from "../server/operational-startup";
import {
  configureShutdownRuntime,
  requestShutdown,
} from "../server/server-lifecycle";
import { createDaemonHttpHandler } from "./http-router";

const port = Number.parseInt(
  process.env.MULTIAGENTS_DAEMON_PORT || "3000",
  10,
);
const hostname =
  process.env.MULTIAGENTS_DAEMON_HOST || "127.0.0.1";

if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) {
  throw new Error("daemon_host_must_be_loopback");
}

let server: Server | undefined;
let accepting = true;
let closeStarted: Promise<void> | undefined;
let exitStarted = false;
let operationalReady = false;

const resources = {
  httpListening: false,
};

configureShutdownRuntime({
  resources,
  stopAcceptingHttp() {
    accepting = false;
  },
  async closeHttp(remainingMs) {
    if (!server || !resources.httpListening) return;

    closeStarted ??= new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("http_server_close_timed_out")),
        remainingMs,
      );
      timer.unref();
    });

    try {
      await Promise.race([closeStarted, timeout]);
    } catch (error) {
      server.closeAllConnections();
      throw error;
    }
  },
});

async function signalShutdown(signal: string) {
  if (exitStarted) return;
  exitStarted = true;

  const shutdownId = randomUUID();
  const result = await requestShutdown(signal, shutdownId);

  process.exitCode = result.success ? 0 : 1;
  process.exit(process.exitCode);
}

async function main() {
  console.info(
    "startup_phase",
    JSON.stringify({ phase: "operational_init" }),
  );

  await initializeOperationalStartup();
  operationalReady = true;

  const handler = createDaemonHttpHandler();

  server = createServer((request, response) => {
    if (!accepting) {
      response.statusCode = 503;
      response.end("shutting_down");
      return;
    }

    void handler(request, response).catch((error) => {
      console.error(
        "daemon_request_failed",
        error instanceof Error ? error.message : "unknown",
      );

      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json");
      }

      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: "internal_error" }));
      }
    });
  });

  process.on("SIGTERM", () => {
    void signalShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void signalShutdown("SIGINT");
  });

  await new Promise<void>((resolve, reject) => {
    server!.listen(port, hostname, () => resolve());
    server!.once("error", reject);
  });

  resources.httpListening = true;

  console.info(
    "startup_ready",
    JSON.stringify({ hostname, port, transport: "daemon" }),
  );
  console.info(
    `MultiAgents daemon listening on http://${hostname}:${port}`,
  );
}

main().catch(async (error) => {
  console.error(
    "startup_failed",
    error instanceof Error ? error.message : "unknown",
  );

  if (operationalReady) {
    try {
      await requestShutdown("startup_failed");
      process.exitCode = 1;
    } catch {
      process.exitCode = 1;
    }
  } else {
    process.exitCode = 1;
  }
});
