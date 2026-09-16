import type { IncomingMessage, ServerResponse } from "node:http";
import {
  taskCiService,
  TaskCiNotFoundError,
} from "../core/task-ci-service";
import {
  taskDetailService,
  TaskDetailNotFoundError,
} from "../core/task-detail-service";
import {
  taskFindingsService,
  TaskFindingsLoadError,
} from "../core/task-findings-service";
import {
  taskHistoryService,
  TaskHistoryNotFoundError,
} from "../core/task-history-service";
import {
  taskPrService,
  TaskPrConflictError,
  TaskPrNotFoundError,
} from "../core/task-pr-service";
import {
  taskProfileService,
  TaskProfileInvalidError,
  TaskProfileNotFoundError,
} from "../core/task-profile-service";
import {
  taskRuntimePolicyService,
  TaskRuntimePolicyNotFoundError,
  TaskRuntimePolicyUnavailableError,
} from "../core/task-runtime-policy-service";
import {
  taskSandboxPolicyService,
  TaskSandboxPolicyNotFoundError,
  TaskSandboxPolicyUnavailableError,
} from "../core/task-sandbox-policy-service";
import { taskService } from "../core/task-service";
import {
  healthReadiness,
  ReadinessError,
} from "../server/operational-health";

type DaemonHttpDependencies = {
  health: typeof healthReadiness;
  listTasks: typeof taskService.list;
  loadTaskDetail: typeof taskDetailService.load;
  loadTaskHistory: typeof taskHistoryService.load;
  loadTaskProfile: typeof taskProfileService.load;
  loadTaskFindings: typeof taskFindingsService.load;
  loadTaskCi: typeof taskCiService.load;
  loadTaskPr: typeof taskPrService.load;
  loadTaskSandboxPolicy: typeof taskSandboxPolicyService.load;
  loadTaskRuntimePolicy: typeof taskRuntimePolicyService.load;
};

export function createDaemonHttpHandler(
  dependencies: DaemonHttpDependencies = {
    health: healthReadiness,
    listTasks: () => taskService.list(),
    loadTaskDetail: (id) => taskDetailService.load(id),
    loadTaskHistory: (id) => taskHistoryService.load(id),
    loadTaskProfile: (id) => taskProfileService.load(id),
    loadTaskFindings: (id) => taskFindingsService.load(id),
    loadTaskCi: (id) => taskCiService.load(id),
    loadTaskPr: (id) => taskPrService.load(id),
    loadTaskSandboxPolicy: (id) => taskSandboxPolicyService.load(id),
    loadTaskRuntimePolicy: (id) => taskRuntimePolicyService.load(id),
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

    if (request.method === "GET" && url.pathname === "/tasks/history") {
      try {
        const tasks = await dependencies.listTasks();
        writeJson(response, 200, { tasks });
      } catch (error) {
        console.error(
          "daemon_task_history_list_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_history_list_failed" });
      }
      return;
    }

    const historyTaskId = matchTaskLeafPath(url.pathname, "history");
    if (historyTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskHistory(historyTaskId),
        );
      } catch (error) {
        if (error instanceof TaskHistoryNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        console.error(
          "daemon_task_history_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_history_failed" });
      }
      return;
    }

    const profileTaskId = matchTaskLeafPath(url.pathname, "profile");
    if (profileTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskProfile(profileTaskId),
        );
      } catch (error) {
        if (error instanceof TaskProfileNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskProfileInvalidError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_profile_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_profile_failed" });
      }
      return;
    }

    const findingsTaskId = matchTaskLeafPath(url.pathname, "findings");
    if (findingsTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskFindings(findingsTaskId),
        );
      } catch (error) {
        if (error instanceof TaskFindingsLoadError) {
          writeJson(response, 404, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_findings_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_findings_failed" });
      }
      return;
    }

    const prTaskId = matchTaskLeafPath(url.pathname, "pr");
    if (prTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(response, 200, await dependencies.loadTaskPr(prTaskId));
      } catch (error) {
        if (error instanceof TaskPrNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskPrConflictError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_pr_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_pr_failed" });
      }
      return;
    }

    const ciTaskId = matchTaskLeafPath(url.pathname, "ci");
    if (ciTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(response, 200, await dependencies.loadTaskCi(ciTaskId));
      } catch (error) {
        if (error instanceof TaskCiNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        console.error(
          "daemon_task_ci_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_ci_failed" });
      }
      return;
    }

    const sandboxPolicyTaskId = matchTaskLeafPath(url.pathname, "sandbox-policy");
    if (sandboxPolicyTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskSandboxPolicy(sandboxPolicyTaskId),
        );
      } catch (error) {
        if (error instanceof TaskSandboxPolicyNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskSandboxPolicyUnavailableError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_sandbox_policy_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_sandbox_policy_failed" });
      }
      return;
    }

    const runtimePolicyTaskId = matchTaskLeafPath(url.pathname, "runtime-policy");
    if (runtimePolicyTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskRuntimePolicy(runtimePolicyTaskId),
        );
      } catch (error) {
        if (error instanceof TaskRuntimePolicyNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskRuntimePolicyUnavailableError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_runtime_policy_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_runtime_policy_failed" });
      }
      return;
    }

    const taskId = matchTaskIdPath(url.pathname);
    if (taskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        const detail = await dependencies.loadTaskDetail(taskId);
        const body = detail.error
          ? { diff: detail.diff, task: detail.task, error: detail.error }
          : { diff: detail.diff, task: detail.task };
        writeJson(response, detail.conflict ? 409 : 200, body);
      } catch (error) {
        if (error instanceof TaskDetailNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        console.error(
          "daemon_task_detail_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_detail_failed" });
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

function matchTaskIdPath(pathname: string) {
  return decodeTaskIdSegment(/^\/tasks\/([^/]+)$/.exec(pathname)?.[1]);
}

function matchTaskLeafPath(
  pathname: string,
  leaf:
    | "history"
    | "profile"
    | "findings"
    | "pr"
    | "ci"
    | "sandbox-policy"
    | "runtime-policy",
) {
  const match = /^\/tasks\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || match[2] !== leaf) return;
  return decodeTaskIdSegment(match[1]);
}

function decodeTaskIdSegment(rawId: string | undefined) {
  if (!rawId) return;

  try {
    const id = decodeURIComponent(rawId);
    return id || undefined;
  } catch {
    return;
  }
}
