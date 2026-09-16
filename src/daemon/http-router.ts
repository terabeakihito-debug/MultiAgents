import type { IncomingMessage, ServerResponse } from "node:http";
import { taskService } from "../core/task-service";
import {
  healthReadiness,
  ReadinessError,
} from "../server/operational-health";

type DaemonHttpDependencies = {
  health: typeof healthReadiness;
  listTasks: typeof taskService.list;
};

export function createDaemonHttpHandler(
  dependencies: DaemonHttpDependencies = {
    health: healthReadiness,
    listTasks: () => taskService.list(),
  },
) {
  return async function handleDaemonHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const rejection = rejectNonLocalRequest(request);
    if (rejection) {
      writeJson(response, rejection.status, { error: rejection.error });
      return;
    }

    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host}`,
    );

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const result = await dependencies.health();
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 503, {
          status: "unavailable",
          database: "unavailable",
          errorCode:
            error instanceof ReadinessError
              ? error.message
              : "readiness_failed",
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/tasks") {
      try {
        const tasks = await dependencies.listTasks();
        writeJson(response, 200, { tasks });
      } catch (error) {
        console.error(
          "daemon_task_list_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_list_failed" });
      }
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}


const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function rejectNonLocalRequest(
  request: IncomingMessage,
): { status: number; error: string } | undefined {
  const hostHeader = request.headers.host;
  if (!hostHeader || !isLoopbackHost(hostHeader)) {
    return { status: 403, error: "This API is available only on localhost" };
  }

  const origin = request.headers.origin;
  if (!origin) return;

  try {
    const originUrl = new URL(origin);
    const requestOrigin = new URL(`http://${hostHeader}`).origin;

    if (
      !LOOPBACK_HOSTS.has(originUrl.hostname) ||
      originUrl.origin !== requestOrigin
    ) {
      return { status: 403, error: "Cross-origin requests are not allowed" };
    }
  } catch {
    return { status: 403, error: "Invalid Origin header" };
  }
}

function isLoopbackHost(hostHeader: string) {
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}
