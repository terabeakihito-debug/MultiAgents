import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { TaskCiNotFoundError } from "../core/task-ci-service";
import { DashboardQueryError } from "../core/dashboard-tasks-service";
import { RepoProfileNotFoundError } from "../core/repo-profile-service";
import { RepoTemplatesNotFoundError } from "../core/repo-templates-service";
import { RemediationQueueQueryError } from "../core/findings-queue-service";
import { NotificationInputError } from "../core/notification-list-service";
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
    loadProfileList: vi.fn(() => ({
      presets: [{ id: "safe_default" }],
      profiles: [],
      versions: [],
    })) as never,
    loadRepoList: vi.fn(async () => ({
      repos: [{ id: "repo-1", templates: [], settings: {} }],
    })) as never,
    loadCredentialStatus: vi.fn(() => ({
      credentials: [{ capability: "github", status: "ready" }],
    })) as never,
    loadNotifications: vi.fn(() => ({
      notifications: [{ id: "n-1" }],
      unreadCount: 1,
    })) as never,
    loadFindingsQueue: vi.fn(() => ({
      findings: [{ findingId: "f-1" }],
      counts: { total: 1 },
      limit: 100,
      offset: 0,
    })) as never,
    loadOperationsOverview: vi.fn(async () => ({
      overall: "ok",
      database: { status: "ok" },
    })) as never,
    loadDashboardTasks: vi.fn(async () => ({
      tasks: [{ id: "task-1" }],
      counts: {},
    })) as never,
    loadRuntimeSandboxStatus: vi.fn(async () => ({
      statusCode: 200,
      body: { status: "enforced", backend: "bubblewrap" },
    })) as never,
    loadNotificationPreferences: vi.fn(() => ({
      preferences: { taskInactive: true },
    })) as never,
    loadRetentionPolicy: vi.fn(() => ({
      preset: "conservative",
    })) as never,
    loadCleanupCandidates: vi.fn(async () => ({
      candidates: [],
      potentialSavingsBytes: 0,
      blocked: 0,
      preset: "conservative",
    })) as never,
    loadRepoProfile: vi.fn(async () => ({
      profile: { repoId: "repo-1", profileId: "safe_default" },
    })) as never,
    loadRepoTemplates: vi.fn(async () => ({
      templates: [{ templateId: "bug_fix" }],
      settings: { defaultTemplateId: "bug_fix" },
    })) as never,
    ...overrides,
  };
}

describe("daemon HTTP router", () => {
  it("serves the profile catalog through the core profile-list boundary", async () => {
    const catalog = {
      presets: [{ id: "safe_default" }],
      profiles: [{ id: "profile-1" }],
      versions: [{ id: "v1" }],
    };
    const loadProfileList = vi.fn(() => catalog) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadProfileList }),
    );
    const output = response();

    await handler(request("GET", "/profiles"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(catalog);
    expect(loadProfileList).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when profile listing fails", async () => {
    const loadProfileList = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadProfileList }),
    );
    const output = response();

    await handler(request("GET", "/profiles"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "profile_list_failed" });
  });

  it("does not expose profile listing on unsupported methods", async () => {
    const loadProfileList = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadProfileList }),
    );
    const output = response();

    await handler(request("POST", "/profiles"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadProfileList).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on profile listing", async () => {
    const loadProfileList = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadProfileList }),
    );
    const output = response();
    const incoming = request("GET", "/profiles");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadProfileList).not.toHaveBeenCalled();
  });

  it("serves the repository catalog through the core repo-list boundary", async () => {
    const payload = {
      repos: [{ id: "repo-1", name: "Repo One", templates: [], settings: {} }],
    };
    const loadRepoList = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoList }),
    );
    const output = response();

    await handler(request("GET", "/repos"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadRepoList).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when repository listing fails", async () => {
    const loadRepoList = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoList }),
    );
    const output = response();

    await handler(request("GET", "/repos"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "repo_list_failed" });
  });

  it("does not expose repository listing on unsupported methods", async () => {
    const loadRepoList = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoList }),
    );
    const output = response();

    await handler(request("POST", "/repos"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadRepoList).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on repository listing", async () => {
    const loadRepoList = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoList }),
    );
    const output = response();
    const incoming = request("GET", "/repos");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadRepoList).not.toHaveBeenCalled();
  });

  it("serves repository profile through the core repo-profile boundary", async () => {
    const payload = { profile: { repoId: "repo-1", profileId: "safe_default" } };
    const loadRepoProfile = vi.fn(async () => payload) as never;
    const loadRepoList = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoProfile, loadRepoList }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/profile"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadRepoProfile).toHaveBeenCalledWith("repo-1");
    expect(loadRepoList).not.toHaveBeenCalled();
  });

  it("returns 404 when the repository profile lookup fails", async () => {
    const loadRepoProfile = vi.fn(async () => {
      throw new RepoProfileNotFoundError("Repository not found");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoProfile }),
    );
    const output = response();

    await handler(request("GET", "/repos/missing/profile"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Repository not found" });
  });

  it("returns a stable error when repository profile loading fails unexpectedly", async () => {
    const loadRepoProfile = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoProfile }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/profile"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "repo_profile_failed" });
  });

  it("does not expose repository profile mutations on the daemon", async () => {
    const loadRepoProfile = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoProfile }),
    );
    const output = response();

    await handler(request("POST", "/repos/repo-1/profile"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadRepoProfile).not.toHaveBeenCalled();
  });

  it("does not treat repository templates as repository profile", async () => {
    const loadRepoProfile = vi.fn() as never;
    const loadRepoTemplates = vi.fn(async () => ({
      templates: [],
      settings: { defaultTemplateId: "bug_fix" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoProfile, loadRepoTemplates }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/templates"), output.value);

    expect(output.status()).toBe(200);
    expect(loadRepoProfile).not.toHaveBeenCalled();
    expect(loadRepoTemplates).toHaveBeenCalledWith("repo-1");
  });

  it("serves repository templates through the core repo-templates boundary", async () => {
    const payload = {
      templates: [{ templateId: "bug_fix" }],
      settings: { defaultTemplateId: "bug_fix" },
    };
    const loadRepoTemplates = vi.fn(async () => payload) as never;
    const loadRepoProfile = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoTemplates, loadRepoProfile }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/templates"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadRepoTemplates).toHaveBeenCalledWith("repo-1");
    expect(loadRepoProfile).not.toHaveBeenCalled();
  });

  it("returns 404 when the repository templates lookup fails", async () => {
    const loadRepoTemplates = vi.fn(async () => {
      throw new RepoTemplatesNotFoundError("Repository not found");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoTemplates }),
    );
    const output = response();

    await handler(request("GET", "/repos/missing/templates"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Repository not found" });
  });

  it("returns a stable error when repository templates loading fails unexpectedly", async () => {
    const loadRepoTemplates = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoTemplates }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/templates"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "repo_templates_failed" });
  });

  it("does not expose repository template mutations on the daemon", async () => {
    const loadRepoTemplates = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoTemplates }),
    );
    const output = response();

    await handler(request("POST", "/repos/repo-1/templates"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadRepoTemplates).not.toHaveBeenCalled();
  });

  it("does not treat repository pulls as repository templates", async () => {
    const loadRepoTemplates = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoTemplates }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/pulls"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadRepoTemplates).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on repository templates", async () => {
    const loadRepoTemplates = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoTemplates }),
    );
    const output = response();
    const incoming = request("GET", "/repos/repo-1/templates");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadRepoTemplates).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on repository profile", async () => {
    const loadRepoProfile = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoProfile }),
    );
    const output = response();
    const incoming = request("GET", "/repos/repo-1/profile");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadRepoProfile).not.toHaveBeenCalled();
  });

  it("serves credential status through the core credential-status boundary", async () => {
    const payload = {
      credentials: [{ capability: "github", status: "ready" }],
    };
    const loadCredentialStatus = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCredentialStatus }),
    );
    const output = response();

    await handler(request("GET", "/credentials/status"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadCredentialStatus).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when credential status loading fails", async () => {
    const loadCredentialStatus = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCredentialStatus }),
    );
    const output = response();

    await handler(request("GET", "/credentials/status"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "credential_status_failed" });
  });

  it("does not expose credential status on unsupported methods", async () => {
    const loadCredentialStatus = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCredentialStatus }),
    );
    const output = response();

    await handler(request("POST", "/credentials/status"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadCredentialStatus).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on credential status", async () => {
    const loadCredentialStatus = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCredentialStatus }),
    );
    const output = response();
    const incoming = request("GET", "/credentials/status");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadCredentialStatus).not.toHaveBeenCalled();
  });

  it("serves cleanup candidates through the core cleanup-candidates boundary", async () => {
    const payload = {
      candidates: [{ id: "worktree-1" }],
      potentialSavingsBytes: 4096,
      blocked: 1,
      preset: "balanced",
    };
    const loadCleanupCandidates = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCleanupCandidates }),
    );
    const output = response();

    await handler(request("GET", "/cleanup/candidates"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadCleanupCandidates).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when cleanup candidate loading fails", async () => {
    const loadCleanupCandidates = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCleanupCandidates }),
    );
    const output = response();

    await handler(request("GET", "/cleanup/candidates"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "cleanup_candidates_failed" });
  });

  it("does not expose cleanup preview or execute on the candidates path", async () => {
    const loadCleanupCandidates = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCleanupCandidates }),
    );

    for (const method of ["POST", "DELETE"] as const) {
      const output = response();
      await handler(request(method, "/cleanup/candidates"), output.value);
      expect(output.status()).toBe(404);
      expect(output.json()).toEqual({ error: "Not found" });
    }

    expect(loadCleanupCandidates).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on cleanup candidates", async () => {
    const loadCleanupCandidates = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadCleanupCandidates }),
    );
    const output = response();
    const incoming = request("GET", "/cleanup/candidates");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadCleanupCandidates).not.toHaveBeenCalled();
  });

  it("serves retention policy through the core retention-policy boundary", async () => {
    const payload = { preset: "balanced" };
    const loadRetentionPolicy = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRetentionPolicy }),
    );
    const output = response();

    await handler(request("GET", "/retention-policy"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadRetentionPolicy).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when retention policy loading fails", async () => {
    const loadRetentionPolicy = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRetentionPolicy }),
    );
    const output = response();

    await handler(request("GET", "/retention-policy"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "retention_policy_failed" });
  });

  it("does not expose retention policy mutations on the daemon", async () => {
    const loadRetentionPolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRetentionPolicy }),
    );
    const output = response();

    await handler(request("POST", "/retention-policy"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadRetentionPolicy).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on retention policy", async () => {
    const loadRetentionPolicy = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRetentionPolicy }),
    );
    const output = response();
    const incoming = request("GET", "/retention-policy");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadRetentionPolicy).not.toHaveBeenCalled();
  });

  it("serves notification preferences through the core notification-preferences boundary", async () => {
    const payload = { preferences: { taskInactive: true, taskFailed: false } };
    const loadNotificationPreferences = vi.fn(() => payload) as never;
    const loadNotifications = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotificationPreferences, loadNotifications }),
    );
    const output = response();

    await handler(request("GET", "/notification-preferences"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(loadNotifications).not.toHaveBeenCalled();
  });

  it("returns a stable error when notification preferences loading fails", async () => {
    const loadNotificationPreferences = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotificationPreferences }),
    );
    const output = response();

    await handler(request("GET", "/notification-preferences"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "notification_preferences_failed" });
  });

  it("does not expose notification preferences mutations on the daemon", async () => {
    const loadNotificationPreferences = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotificationPreferences }),
    );
    const output = response();

    await handler(request("POST", "/notification-preferences"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadNotificationPreferences).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on notification preferences", async () => {
    const loadNotificationPreferences = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotificationPreferences }),
    );
    const output = response();
    const incoming = request("GET", "/notification-preferences");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadNotificationPreferences).not.toHaveBeenCalled();
  });

  it("serves notifications through the core notification-list boundary", async () => {
    const payload = {
      notifications: [{ id: "n-1" }],
      unreadCount: 2,
    };
    const loadNotifications = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotifications }),
    );
    const output = response();

    await handler(request("GET", "/notifications?unreadOnly=true"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadNotifications).toHaveBeenCalledTimes(1);
    const calledUrl = (loadNotifications as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as URL;
    expect(calledUrl.pathname).toBe("/notifications");
    expect(calledUrl.searchParams.get("unreadOnly")).toBe("true");
  });

  it("returns 400 when notification query parameters are invalid", async () => {
    const loadNotifications = vi.fn(() => {
      throw new NotificationInputError("Invalid notification limit");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotifications }),
    );
    const output = response();

    await handler(request("GET", "/notifications?limit=0"), output.value);

    expect(output.status()).toBe(400);
    expect(output.json()).toEqual({ error: "Invalid notification limit" });
  });

  it("returns a stable error when notification listing fails unexpectedly", async () => {
    const loadNotifications = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotifications }),
    );
    const output = response();

    await handler(request("GET", "/notifications"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "notification_list_failed" });
  });

  it("does not expose notification listing on unsupported methods", async () => {
    const loadNotifications = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotifications }),
    );
    const output = response();

    await handler(request("POST", "/notifications"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadNotifications).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on notification listing", async () => {
    const loadNotifications = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadNotifications }),
    );
    const output = response();
    const incoming = request("GET", "/notifications");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadNotifications).not.toHaveBeenCalled();
  });

  it("serves the findings queue through the core findings-queue boundary", async () => {
    const payload = {
      findings: [{ findingId: "f-1" }],
      counts: { total: 1 },
      limit: 50,
      offset: 0,
    };
    const loadFindingsQueue = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadFindingsQueue }),
    );
    const output = response();

    await handler(request("GET", "/findings/queue?limit=50"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadFindingsQueue).toHaveBeenCalledTimes(1);
    const calledUrl = (loadFindingsQueue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as URL;
    expect(calledUrl.pathname).toBe("/findings/queue");
    expect(calledUrl.searchParams.get("limit")).toBe("50");
  });

  it("returns 400 when findings queue query parameters are invalid", async () => {
    const loadFindingsQueue = vi.fn(() => {
      throw new RemediationQueueQueryError("Invalid sort order");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadFindingsQueue }),
    );
    const output = response();

    await handler(request("GET", "/findings/queue?sort=bad"), output.value);

    expect(output.status()).toBe(400);
    expect(output.json()).toEqual({ error: "Invalid sort order" });
  });

  it("returns a stable error when findings queue loading fails unexpectedly", async () => {
    const loadFindingsQueue = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadFindingsQueue }),
    );
    const output = response();

    await handler(request("GET", "/findings/queue"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "findings_queue_failed" });
  });

  it("does not expose findings queue on unsupported methods", async () => {
    const loadFindingsQueue = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadFindingsQueue }),
    );
    const output = response();

    await handler(request("POST", "/findings/queue"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadFindingsQueue).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on findings queue", async () => {
    const loadFindingsQueue = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadFindingsQueue }),
    );
    const output = response();
    const incoming = request("GET", "/findings/queue");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadFindingsQueue).not.toHaveBeenCalled();
  });

  it("serves operations overview through the core operations-overview boundary", async () => {
    const payload = { overall: "ok", maintenance: { state: "RUNNING" } };
    const loadOperationsOverview = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOperationsOverview }),
    );
    const output = response();

    await handler(request("GET", "/operations/overview"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadOperationsOverview).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when operations overview loading fails", async () => {
    const loadOperationsOverview = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOperationsOverview }),
    );
    const output = response();

    await handler(request("GET", "/operations/overview"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "operations_overview_failed" });
  });

  it("does not expose operations overview on unsupported methods", async () => {
    const loadOperationsOverview = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOperationsOverview }),
    );
    const output = response();

    await handler(request("POST", "/operations/overview"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadOperationsOverview).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on operations overview", async () => {
    const loadOperationsOverview = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOperationsOverview }),
    );
    const output = response();
    const incoming = request("GET", "/operations/overview");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadOperationsOverview).not.toHaveBeenCalled();
  });

  it("serves dashboard tasks through the core dashboard-tasks boundary", async () => {
    const payload = { tasks: [{ id: "task-1" }], counts: { active: 1 } };
    const loadDashboardTasks = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadDashboardTasks }),
    );
    const output = response();

    await handler(request("GET", "/dashboard/tasks?limit=25"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadDashboardTasks).toHaveBeenCalledTimes(1);
    const calledUrl = (loadDashboardTasks as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as URL;
    expect(calledUrl.pathname).toBe("/dashboard/tasks");
    expect(calledUrl.searchParams.get("limit")).toBe("25");
  });

  it("returns 400 when dashboard task query parameters are invalid", async () => {
    const loadDashboardTasks = vi.fn(async () => {
      throw new DashboardQueryError("Invalid bucket");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadDashboardTasks }),
    );
    const output = response();

    await handler(request("GET", "/dashboard/tasks?bucket=bad"), output.value);

    expect(output.status()).toBe(400);
    expect(output.json()).toEqual({ error: "Invalid bucket" });
  });

  it("returns a stable error when dashboard task loading fails unexpectedly", async () => {
    const loadDashboardTasks = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadDashboardTasks }),
    );
    const output = response();

    await handler(request("GET", "/dashboard/tasks"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "dashboard_tasks_failed" });
  });

  it("does not expose dashboard tasks on unsupported methods", async () => {
    const loadDashboardTasks = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadDashboardTasks }),
    );
    const output = response();

    await handler(request("POST", "/dashboard/tasks"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadDashboardTasks).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on dashboard tasks", async () => {
    const loadDashboardTasks = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadDashboardTasks }),
    );
    const output = response();
    const incoming = request("GET", "/dashboard/tasks");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadDashboardTasks).not.toHaveBeenCalled();
  });

  it("serves runtime sandbox status through the core sandbox-status boundary", async () => {
    const payload = {
      statusCode: 200,
      body: {
        status: "enforced",
        backend: "bubblewrap",
        policyVersion: 3,
      },
    };
    const loadRuntimeSandboxStatus = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRuntimeSandboxStatus }),
    );
    const output = response();

    await handler(request("GET", "/runtime/sandbox-status"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload.body);
    expect(loadRuntimeSandboxStatus).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when runtime sandbox status is unavailable", async () => {
    const loadRuntimeSandboxStatus = vi.fn(async () => ({
      statusCode: 503,
      body: {
        status: "unavailable",
        error: "OS sandbox unavailable. Task execution blocked.",
        failureCode: "namespace_unsupported",
      },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRuntimeSandboxStatus }),
    );
    const output = response();

    await handler(request("GET", "/runtime/sandbox-status"), output.value);

    expect(output.status()).toBe(503);
    expect(output.json()).toEqual({
      status: "unavailable",
      error: "OS sandbox unavailable. Task execution blocked.",
      failureCode: "namespace_unsupported",
    });
  });

  it("returns a stable error when runtime sandbox status loading fails unexpectedly", async () => {
    const loadRuntimeSandboxStatus = vi.fn(async () => {
      throw new Error("unexpected");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRuntimeSandboxStatus }),
    );
    const output = response();

    await handler(request("GET", "/runtime/sandbox-status"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "runtime_sandbox_status_failed" });
  });

  it("does not expose runtime sandbox status on unsupported methods", async () => {
    const loadRuntimeSandboxStatus = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRuntimeSandboxStatus }),
    );
    const output = response();

    await handler(request("POST", "/runtime/sandbox-status"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadRuntimeSandboxStatus).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on runtime sandbox status", async () => {
    const loadRuntimeSandboxStatus = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRuntimeSandboxStatus }),
    );
    const output = response();
    const incoming = request("GET", "/runtime/sandbox-status");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadRuntimeSandboxStatus).not.toHaveBeenCalled();
  });

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
