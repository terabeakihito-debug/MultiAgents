import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { TaskCiNotFoundError } from "../core/task-ci-service";
import {
  TaskPrConflictError,
  TaskPrNotFoundError,
} from "../core/task-pr-service";
import { TaskDetailNotFoundError } from "../core/task-detail-service";
import { TaskFindingsLoadError } from "../core/task-findings-service";
import { TaskHistoryNotFoundError } from "../core/task-history-service";
import {
  TaskProfileInvalidError,
  TaskProfileNotFoundError,
} from "../core/task-profile-service";
import {
  TaskRuntimePolicyNotFoundError,
  TaskRuntimePolicyUnavailableError,
} from "../core/task-runtime-policy-service";
import {
  TaskSandboxPolicyNotFoundError,
  TaskSandboxPolicyUnavailableError,
} from "../core/task-sandbox-policy-service";
import { createDaemonHttpHandler } from "./http-router";

function request(
  method: string,
  url: string,
): IncomingMessage {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1",
    },
  } as IncomingMessage;
}

function response() {
  const headers = new Map<string, string>();
  let body = "";

  const value = {
    statusCode: 200,
    setHeader(name: string, headerValue: string) {
      headers.set(name.toLowerCase(), headerValue);
      return value;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      return value;
    },
  } as unknown as ServerResponse;

  return {
    value,
    status: () => value.statusCode,
    header: (name: string) => headers.get(name.toLowerCase()),
    json: () => JSON.parse(body) as unknown,
  };
}

function dependencies(
  overrides: Partial<Parameters<typeof createDaemonHttpHandler>[0]> = {},
): Parameters<typeof createDaemonHttpHandler>[0] {
  return {
    health: vi.fn(async () => ({ status: "ready" })) as never,
    listTasks: vi.fn(async () => []),
    loadTaskDetail: vi.fn(async () => ({
      task: { id: "task-1" },
      diff: { patch: "" },
      conflict: false,
    })) as never,
    loadTaskHistory: vi.fn(async () => ({
      history: { events: [] },
    })) as never,
    loadTaskProfile: vi.fn(async () => ({
      profile: { id: "default" },
    })) as never,
    loadTaskFindings: vi.fn(async () => ({
      findings: [],
    })) as never,
    loadTaskCi: vi.fn(async () => ({
      task: { id: "task-1" },
      checks: [],
      message: undefined,
    })) as never,
    loadTaskPr: vi.fn(async () => ({
      task: { id: "task-1" },
      pullRequest: { title: "Fix" },
      intake: undefined,
    })) as never,
    loadTaskSandboxPolicy: vi.fn(async () => ({
      status: "enforced",
      validation: { profile: "validation" },
      agents: [],
    })) as never,
    loadTaskRuntimePolicy: vi.fn(async () => ({
      runtimePolicyVersion: 2,
      taskType: "bug_fix",
      policies: [],
    })) as never,
    ...overrides,
  };
}

describe("daemon HTTP router", () => {
  it("serves the task list through the core task boundary", async () => {
    const tasks = [{ id: "task-1" }, { id: "task-2" }];
    const listTasks = vi.fn(async () => tasks) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("GET", "/tasks"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual({ tasks });
    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when task listing fails", async () => {
    const listTasks = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("GET", "/tasks"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_list_failed" });
  });

  it("does not expose task listing on unsupported methods", async () => {
    const listTasks = vi.fn(async () => []) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("POST", "/tasks"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("serves the task history list through the core task boundary", async () => {
    const tasks = [{ id: "task-1" }];
    const listTasks = vi.fn(async () => tasks) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskHistory = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks, loadTaskDetail, loadTaskHistory }),
    );
    const output = response();

    await handler(request("GET", "/tasks/history"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual({ tasks });
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskHistory).not.toHaveBeenCalled();
  });

  it("returns a stable error when the task history list fails", async () => {
    const listTasks = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("GET", "/tasks/history"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_history_list_failed" });
  });

  it("does not expose the task history list on unsupported methods", async () => {
    const listTasks = vi.fn(async () => []) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("POST", "/tasks/history"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("does not treat the task history list path as task detail", async () => {
    const listTasks = vi.fn(async () => [{ id: "task-1" }]) as never;
    const loadTaskDetail = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks, loadTaskDetail }),
    );
    const output = response();

    await handler(request("GET", "/tasks/history"), output.value);

    expect(output.status()).toBe(200);
    expect(loadTaskDetail).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on the task history list", async () => {
    const listTasks = vi.fn(async () => []) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/history");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(listTasks).not.toHaveBeenCalled();
  });


  it("rejects a non-loopback Host header", async () => {
    const handler = createDaemonHttpHandler(dependencies());
    const output = response();
    const incoming = request("GET", "/tasks");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
  });

  it("rejects a mismatched loopback Origin", async () => {
    const handler = createDaemonHttpHandler(dependencies());
    const output = response();
    const incoming = request("GET", "/tasks");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
  });

  it("returns 404 for unknown routes", async () => {
    const handler = createDaemonHttpHandler(dependencies());
    const output = response();

    await handler(request("GET", "/unknown"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
  });

  it("serves task detail through the core task-detail boundary", async () => {
    const detail = {
      task: { id: "task-1" },
      diff: { patch: "diff --git a/README.md b/README.md" },
      conflict: false as const,
    };
    const loadTaskDetail = vi.fn(async () => detail) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual({
      task: detail.task,
      diff: detail.diff,
    });
    expect(loadTaskDetail).toHaveBeenCalledTimes(1);
    expect(loadTaskDetail).toHaveBeenCalledWith("task-1");
  });

  it("returns 404 when the requested task does not exist", async () => {
    const loadTaskDetail = vi.fn(async () => {
      throw new TaskDetailNotFoundError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Task not found" });
  });

  it("returns the conflict payload when task detail reports a diff conflict", async () => {
    const detail = {
      task: { id: "task-1" },
      diff: { patch: "conflict-diff" },
      error: "first diff failed",
      conflict: true as const,
    };
    const loadTaskDetail = vi.fn(async () => detail) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1"), output.value);

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({
      task: detail.task,
      diff: detail.diff,
      error: detail.error,
    });
  });

  it("returns a stable error when task detail loading fails", async () => {
    const loadTaskDetail = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_detail_failed" });
  });

  it("does not expose task detail mutations", async () => {
    const loadTaskDetail = vi.fn(async () => ({
      task: { id: "task-1" },
      diff: { patch: "" },
      conflict: false as const,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskDetail).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on task detail", async () => {
    const loadTaskDetail = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskDetail).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on task detail", async () => {
    const loadTaskDetail = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskDetail).not.toHaveBeenCalled();
  });

  it("does not treat nested task paths as task detail", async () => {
    const payload = {
      task: { id: "task-1" },
      pullRequest: { title: "Fix" },
      intake: undefined,
    };
    const loadTaskDetail = vi.fn() as never;
    const loadTaskHistory = vi.fn() as never;
    const loadTaskProfile = vi.fn() as never;
    const loadTaskFindings = vi.fn() as never;
    const loadTaskCi = vi.fn() as never;
    const loadTaskPr = vi.fn(async () => payload) as never;
    const loadTaskSandboxPolicy = vi.fn() as never;
    const loadTaskRuntimePolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskDetail,
        loadTaskHistory,
        loadTaskProfile,
        loadTaskFindings,
        loadTaskCi,
        loadTaskPr,
        loadTaskSandboxPolicy,
        loadTaskRuntimePolicy,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/pr"), output.value);

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(loadTaskPr).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskHistory).not.toHaveBeenCalled();
    expect(loadTaskProfile).not.toHaveBeenCalled();
    expect(loadTaskFindings).not.toHaveBeenCalled();
    expect(loadTaskCi).not.toHaveBeenCalled();
    expect(loadTaskSandboxPolicy).not.toHaveBeenCalled();
    expect(loadTaskRuntimePolicy).not.toHaveBeenCalled();
  });

  it("serves task history through the core task-history boundary", async () => {
    const history = {
      events: [{ type: "created" }],
      stepVersions: [],
      diffVersions: [],
      approvalEvents: [],
    };
    const loadTaskHistory = vi.fn(async () => ({ history })) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskProfile = vi.fn() as never;
    const loadTaskFindings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskHistory,
        loadTaskDetail,
        loadTaskProfile,
        loadTaskFindings,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/history"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual({ history });
    expect(loadTaskHistory).toHaveBeenCalledTimes(1);
    expect(loadTaskHistory).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskProfile).not.toHaveBeenCalled();
    expect(loadTaskFindings).not.toHaveBeenCalled();
  });

  it("returns 404 when task history does not exist", async () => {
    const loadTaskHistory = vi.fn(async () => {
      throw new TaskHistoryNotFoundError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskHistory }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing/history"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Task not found" });
  });

  it("returns a stable error when task history loading fails", async () => {
    const loadTaskHistory = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskHistory }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/history"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_history_failed" });
  });

  it("does not expose task history mutations", async () => {
    const loadTaskHistory = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskHistory }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1/history"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskHistory).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on task history", async () => {
    const loadTaskHistory = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskHistory }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/history");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskHistory).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on task history", async () => {
    const loadTaskHistory = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskHistory }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/history");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskHistory).not.toHaveBeenCalled();
  });

  it("serves task profile through the core task-profile boundary", async () => {
    const profile = { id: "coding" };
    const loadTaskProfile = vi.fn(async () => ({ profile })) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskHistory = vi.fn() as never;
    const loadTaskFindings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskProfile,
        loadTaskDetail,
        loadTaskHistory,
        loadTaskFindings,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/profile"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual({ profile });
    expect(loadTaskProfile).toHaveBeenCalledTimes(1);
    expect(loadTaskProfile).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskHistory).not.toHaveBeenCalled();
    expect(loadTaskFindings).not.toHaveBeenCalled();
  });

  it("returns 404 when task profile does not exist", async () => {
    const loadTaskProfile = vi.fn(async () => {
      throw new TaskProfileNotFoundError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskProfile }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing/profile"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Task not found" });
  });

  it("returns 409 when the task profile snapshot is invalid", async () => {
    const loadTaskProfile = vi.fn(async () => {
      throw new TaskProfileInvalidError("profile mismatch");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskProfile }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/profile"), output.value);

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({ error: "profile mismatch" });
  });

  it("returns a stable error when task profile loading fails", async () => {
    const loadTaskProfile = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskProfile }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/profile"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_profile_failed" });
  });

  it("does not expose task profile mutations", async () => {
    const loadTaskProfile = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskProfile }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1/profile"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskProfile).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on task profile", async () => {
    const loadTaskProfile = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskProfile }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/profile");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskProfile).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on task profile", async () => {
    const loadTaskProfile = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskProfile }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/profile");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskProfile).not.toHaveBeenCalled();
  });

  it("serves task findings through the core task-findings boundary", async () => {
    const findings = [{ findingId: "finding-1", history: [], remediation: { stage: "open" } }];
    const loadTaskFindings = vi.fn(async () => ({ findings })) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskHistory = vi.fn() as never;
    const loadTaskProfile = vi.fn() as never;
    const loadTaskCi = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskFindings,
        loadTaskDetail,
        loadTaskHistory,
        loadTaskProfile,
        loadTaskCi,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/findings"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual({ findings });
    expect(loadTaskFindings).toHaveBeenCalledTimes(1);
    expect(loadTaskFindings).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskHistory).not.toHaveBeenCalled();
    expect(loadTaskProfile).not.toHaveBeenCalled();
    expect(loadTaskCi).not.toHaveBeenCalled();
  });

  it("returns 404 when task findings cannot be loaded", async () => {
    const loadTaskFindings = vi.fn(async () => {
      throw new TaskFindingsLoadError("Source task not found");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskFindings }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing/findings"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Source task not found" });
  });

  it("returns a stable error when task findings loading fails unexpectedly", async () => {
    const loadTaskFindings = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskFindings }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/findings"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_findings_failed" });
  });

  it("does not expose task findings mutations", async () => {
    const loadTaskFindings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskFindings }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1/findings"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskFindings).not.toHaveBeenCalled();
  });

  it("does not treat findings extract as the findings read", async () => {
    const loadTaskFindings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskFindings }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/findings/extract"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadTaskFindings).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on task findings", async () => {
    const loadTaskFindings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskFindings }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/findings");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskFindings).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on task findings", async () => {
    const loadTaskFindings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskFindings }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/findings");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskFindings).not.toHaveBeenCalled();
  });

  it("serves task CI through the core task-ci boundary", async () => {
    const payload = {
      task: { id: "task-1" },
      checks: [{ name: "ci", state: "SUCCESS" }],
      message: "All checks passed",
    };
    const loadTaskCi = vi.fn(async () => payload) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskHistory = vi.fn() as never;
    const loadTaskProfile = vi.fn() as never;
    const loadTaskFindings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskCi,
        loadTaskDetail,
        loadTaskHistory,
        loadTaskProfile,
        loadTaskFindings,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/ci"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadTaskCi).toHaveBeenCalledTimes(1);
    expect(loadTaskCi).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskHistory).not.toHaveBeenCalled();
    expect(loadTaskProfile).not.toHaveBeenCalled();
    expect(loadTaskFindings).not.toHaveBeenCalled();
  });

  it("returns 404 when the requested CI task does not exist", async () => {
    const loadTaskCi = vi.fn(async () => {
      throw new TaskCiNotFoundError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskCi }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing/ci"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Task not found" });
  });

  it("returns a stable error when task CI loading fails", async () => {
    const loadTaskCi = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskCi }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/ci"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_ci_failed" });
  });

  it("does not expose task CI mutations", async () => {
    const loadTaskCi = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskCi }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1/ci"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskCi).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on task CI", async () => {
    const loadTaskCi = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskCi }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/ci");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskCi).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on task CI", async () => {
    const loadTaskCi = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskCi }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/ci");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskCi).not.toHaveBeenCalled();
  });

  it("serves task PR through the core task-pr boundary", async () => {
    const payload = {
      task: { id: "task-1" },
      pullRequest: { title: "Fix bug" },
      intake: { status: "pending" },
    };
    const loadTaskPr = vi.fn(async () => payload) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskCi = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskPr,
        loadTaskDetail,
        loadTaskCi,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/pr"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadTaskPr).toHaveBeenCalledTimes(1);
    expect(loadTaskPr).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskCi).not.toHaveBeenCalled();
  });

  it("returns 404 when the PR task does not exist", async () => {
    const loadTaskPr = vi.fn(async () => {
      throw new TaskPrNotFoundError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskPr }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing/pr"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Task not found" });
  });

  it("returns 409 when the task has no existing pull request", async () => {
    const loadTaskPr = vi.fn(async () => {
      throw new TaskPrConflictError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskPr }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/pr"), output.value);

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({
      error: "Task does not have an existing pull request",
    });
  });

  it("returns a stable error when task PR loading fails unexpectedly", async () => {
    const loadTaskPr = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskPr }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/pr"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_pr_failed" });
  });

  it("does not expose task PR mutations", async () => {
    const loadTaskPr = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskPr }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1/pr"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskPr).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on task PR", async () => {
    const loadTaskPr = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskPr }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/pr");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskPr).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on task PR", async () => {
    const loadTaskPr = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskPr }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/pr");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskPr).not.toHaveBeenCalled();
  });

  it("serves task sandbox policy through the core sandbox-policy boundary", async () => {
    const payload = {
      status: "enforced" as const,
      validation: { profile: "validation" },
      agents: [{ agent: "codex", profile: "agent_read_only" }],
    };
    const loadTaskSandboxPolicy = vi.fn(async () => payload) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskHistory = vi.fn() as never;
    const loadTaskProfile = vi.fn() as never;
    const loadTaskFindings = vi.fn() as never;
    const loadTaskCi = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskSandboxPolicy,
        loadTaskDetail,
        loadTaskHistory,
        loadTaskProfile,
        loadTaskFindings,
        loadTaskCi,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/sandbox-policy"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadTaskSandboxPolicy).toHaveBeenCalledTimes(1);
    expect(loadTaskSandboxPolicy).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskHistory).not.toHaveBeenCalled();
    expect(loadTaskProfile).not.toHaveBeenCalled();
    expect(loadTaskFindings).not.toHaveBeenCalled();
    expect(loadTaskCi).not.toHaveBeenCalled();
  });

  it("returns 404 when the sandbox-policy task does not exist", async () => {
    const loadTaskSandboxPolicy = vi.fn(async () => {
      throw new TaskSandboxPolicyNotFoundError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskSandboxPolicy }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing/sandbox-policy"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Task not found" });
  });

  it("returns 409 when the sandbox policy is unavailable", async () => {
    const loadTaskSandboxPolicy = vi.fn(async () => {
      throw new TaskSandboxPolicyUnavailableError("OS sandbox unavailable");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskSandboxPolicy }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/sandbox-policy"), output.value);

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({ error: "OS sandbox unavailable" });
  });

  it("returns a stable error when sandbox policy loading fails unexpectedly", async () => {
    const loadTaskSandboxPolicy = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskSandboxPolicy }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/sandbox-policy"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_sandbox_policy_failed" });
  });

  it("does not expose sandbox policy mutations", async () => {
    const loadTaskSandboxPolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskSandboxPolicy }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1/sandbox-policy"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskSandboxPolicy).not.toHaveBeenCalled();
  });

  it("does not treat pr as sandbox policy", async () => {
    const loadTaskSandboxPolicy = vi.fn() as never;
    const loadTaskPr = vi.fn(async () => ({
      task: { id: "task-1" },
      pullRequest: {},
      intake: undefined,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskSandboxPolicy, loadTaskPr }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/pr"), output.value);

    expect(output.status()).toBe(200);
    expect(loadTaskSandboxPolicy).not.toHaveBeenCalled();
    expect(loadTaskPr).toHaveBeenCalledWith("task-1");
  });

  it("rejects a non-loopback Host header on sandbox policy", async () => {
    const loadTaskSandboxPolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskSandboxPolicy }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/sandbox-policy");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskSandboxPolicy).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on sandbox policy", async () => {
    const loadTaskSandboxPolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskSandboxPolicy }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/sandbox-policy");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskSandboxPolicy).not.toHaveBeenCalled();
  });

  it("serves task runtime policy through the core runtime-policy boundary", async () => {
    const payload = {
      runtimePolicyVersion: 2,
      taskType: "bug_fix",
      allAgentsReadOnly: false,
      policies: [{ agent: "codex" }],
    };
    const loadTaskRuntimePolicy = vi.fn(async () => payload) as never;
    const loadTaskDetail = vi.fn() as never;
    const loadTaskSandboxPolicy = vi.fn() as never;
    const loadTaskCi = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        loadTaskRuntimePolicy,
        loadTaskDetail,
        loadTaskSandboxPolicy,
        loadTaskCi,
      }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/runtime-policy"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadTaskRuntimePolicy).toHaveBeenCalledTimes(1);
    expect(loadTaskRuntimePolicy).toHaveBeenCalledWith("task-1");
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadTaskSandboxPolicy).not.toHaveBeenCalled();
    expect(loadTaskCi).not.toHaveBeenCalled();
  });

  it("returns 404 when the runtime-policy task does not exist", async () => {
    const loadTaskRuntimePolicy = vi.fn(async () => {
      throw new TaskRuntimePolicyNotFoundError();
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskRuntimePolicy }),
    );
    const output = response();

    await handler(request("GET", "/tasks/missing/runtime-policy"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Task not found" });
  });

  it("returns 409 when the runtime policy is unavailable", async () => {
    const loadTaskRuntimePolicy = vi.fn(async () => {
      throw new TaskRuntimePolicyUnavailableError("Runtime policy is unavailable");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskRuntimePolicy }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/runtime-policy"), output.value);

    expect(output.status()).toBe(409);
    expect(output.json()).toEqual({ error: "Runtime policy is unavailable" });
  });

  it("returns a stable error when runtime policy loading fails unexpectedly", async () => {
    const loadTaskRuntimePolicy = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskRuntimePolicy }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/runtime-policy"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_runtime_policy_failed" });
  });

  it("does not expose runtime policy mutations", async () => {
    const loadTaskRuntimePolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskRuntimePolicy }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/tasks/task-1/runtime-policy"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadTaskRuntimePolicy).not.toHaveBeenCalled();
  });

  it("does not treat pr as runtime policy", async () => {
    const loadTaskRuntimePolicy = vi.fn() as never;
    const loadTaskPr = vi.fn(async () => ({
      task: { id: "task-1" },
      pullRequest: {},
      intake: undefined,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskRuntimePolicy, loadTaskPr }),
    );
    const output = response();

    await handler(request("GET", "/tasks/task-1/pr"), output.value);

    expect(output.status()).toBe(200);
    expect(loadTaskRuntimePolicy).not.toHaveBeenCalled();
    expect(loadTaskPr).toHaveBeenCalledWith("task-1");
  });

  it("rejects a non-loopback Host header on runtime policy", async () => {
    const loadTaskRuntimePolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskRuntimePolicy }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/runtime-policy");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadTaskRuntimePolicy).not.toHaveBeenCalled();
  });

  it("rejects a mismatched loopback Origin on runtime policy", async () => {
    const loadTaskRuntimePolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskRuntimePolicy }),
    );
    const output = response();
    const incoming = request("GET", "/tasks/task-1/runtime-policy");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(loadTaskRuntimePolicy).not.toHaveBeenCalled();
  });
});
