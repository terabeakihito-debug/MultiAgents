import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TaskCiNotFoundError } from "../core/task-ci-service";
import { DashboardQueryError } from "../core/dashboard-tasks-service";
import { RepoProfileNotFoundError } from "../core/repo-profile-service";
import { RepoPullsRequestError } from "../core/repo-pulls-service";
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
import { humanMutationGateService } from "../core/human-mutation-gate-service";
import { createDaemonHttpHandler } from "./http-router";
import {
  clearHumanMutationSessionsForTests,
  issueHumanMutationNonce,
} from "../server/request-security";

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
    write(chunk: string | Buffer) {
      body += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      }
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
    applyNotificationReadMutation: vi.fn(() => ({
      notificationId: "n-1",
      status: "read",
    })) as never,
    applyNotificationDismissMutation: vi.fn(() => ({
      notificationId: "n-1",
      status: "dismissed",
    })) as never,
    applyNotificationReadAllMutation: vi.fn(() => ({ updated: 2 })) as never,
    applyNotificationSlackRetryMutation: vi.fn(async () => ({
      delivery: { deliveryId: "d-1", status: "pending" },
    })) as never,
    applyNotificationSlackMarkDeliveredMutation: vi.fn(() => ({
      delivery: { deliveryId: "d-1", status: "delivered" },
    })) as never,
    applyNotificationSlackDeliveryDismissMutation: vi.fn(() => ({
      delivery: { deliveryId: "d-1", status: "suppressed" },
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
    loadRepoPulls: vi.fn(async () => ({
      pulls: [{ number: 1, title: "Fix" }],
    })) as never,
    issueHumanSession: vi.fn(() => Response.json(
      { nonce: "nonce-1", expiresAt: "2026-01-01T00:02:00.000Z" },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": "multiagents_human_session=abc; HttpOnly",
        },
      },
    )) as never,
    loadOutboundSlackSettings: vi.fn(() => ({
      configured: true,
      config: { enabled: true },
    })) as never,
    loadMaintenanceState: vi.fn(() => ({
      state: "RUNNING",
    })) as never,
    loadStateBackups: vi.fn(() => ({
      backups: [{ backupId: "b-1" }],
      latest: { backupId: "b-1" },
    })) as never,
    loadStateBackupValidate: vi.fn((backupId: string) => ({
      backup: { backupId, verified: true },
    })) as never,
    rejectHumanMutation: (webRequest, action, options) =>
      humanMutationGateService.reject(webRequest, action, options),
    applyMaintenanceMutation: vi.fn(async () => ({
      state: "RUNNING",
    })) as never,
    initializeTaskRecovery: vi.fn(async () => undefined) as never,
    createTaskFromBody: vi.fn(async () => ({
      task: { id: "task-new", repoId: "repo-1" },
    })) as never,
    initializeTaskDeleteRecovery: vi.fn(async () => undefined) as never,
    parseTaskDeleteBody: vi.fn(() => ({})) as never,
    removeTask: vi.fn(async () => undefined) as never,
    applyTaskApproveMutation: vi.fn(async () => ({
      task: { id: "task-1", status: "open" },
    })) as never,
    applyTaskApproveReworkMutation: vi.fn(async () => ({
      task: { id: "task-1", status: "open" },
    })) as never,
    applyTaskApplyReviewMutation: vi.fn(async () => ({
      task: { id: "task-1", status: "open" },
    })) as never,
    applyTaskPrepareApprovalMutation: vi.fn(async () => ({
      status: 200,
      body: { diff: {}, task: { id: "task-1" } },
    })) as never,
    applyTaskCreatePrMutation: vi.fn(async () => ({
      task: { id: "task-1", prNumber: 42 },
    })) as never,
    applyRetentionPolicyMutation: vi.fn(() => ({ preset: "balanced" })) as never,
    applyCleanupPreviewMutation: vi.fn(async () => ({
      selected: [],
      estimatedBytes: 0,
    })) as never,
    applyCleanupExecuteMutation: vi.fn(async () => ({
      completed: [],
      estimatedBytes: 0,
    })) as never,
    createStateBackup: vi.fn(async () => ({
      backup: { backupId: "b-new", verified: false },
    })) as never,
    applyNotificationPreferencesMutation: vi.fn(() => ({
      preferences: { taskInactive: true },
    })) as never,
    applyOutboundSlackSettingsMutation: vi.fn(() => ({
      configured: true,
      config: { enabled: true },
    })) as never,
    applyRepoProfileMutation: vi.fn(async () => ({
      profile: { repoId: "repo-1", profileId: "safe_default" },
    })) as never,
    applyRepoTemplatesMutation: vi.fn(async () => ({
      templates: [{ templateId: "bug_fix", enabled: true }],
      settings: { defaultTemplateId: "bug_fix" },
    })) as never,
    applyAgentRunMutation: vi.fn(async () => ({
      status: "completed",
      output: "done",
    })) as never,
    applyAgentParallelRunMutation: vi.fn(async () => ({
      results: [{ status: "completed" }],
    })) as never,
    applyReviewFlowMutation: vi.fn(async () => ({
      flowId: "flow-1",
      steps: [],
    })) as never,
    prepareReviewRerun: vi.fn(async () => ({
      kind: "error",
      status: 400,
      body: { error: "A valid taskId is required" },
    })) as never,
    prepareReviewFlowStream: vi.fn(async () => ({
      kind: "error",
      status: 400,
      body: { error: "Prompt is required" },
    })) as never,
    applyTaskFindingsExtractMutation: vi.fn(async () => ({
      findings: [{ findingId: "f-1" }],
    })) as never,
    applyFindingAcceptMutation: vi.fn(async () => ({
      finding: { findingId: "f-1", status: "accepted" },
      remediation: null,
      history: [],
    })) as never,
    applyFindingDismissMutation: vi.fn(async () => ({
      finding: { findingId: "f-1", status: "dismissed" },
      remediation: null,
      history: [],
    })) as never,
    applyFindingConvertMutation: vi.fn(async () => ({
      finding: { findingId: "f-1", status: "converted" },
      task: { id: "task-2" },
      remediation: null,
      history: [],
    })) as never,
    applyFindingResolveMutation: vi.fn(async () => ({
      finding: { findingId: "f-1", resolvedAt: "now" },
      remediation: null,
      history: [],
    })) as never,
    applyFindingPriorityMutation: vi.fn(async () => ({
      finding: { findingId: "f-1", humanPriority: "urgent" },
      remediation: null,
      history: [],
    })) as never,
    ...overrides,
  };
}

const MAINTENANCE_ORIGIN = "http://127.0.0.1:3000";

function mutationRequest(
  method: "POST" | "DELETE",
  path: string,
  headers: Record<string, string>,
  jsonBody = "",
): IncomingMessage {
  const stream = Readable.from(
    jsonBody ? [Buffer.from(jsonBody)] : [],
  );
  return Object.assign(stream, {
    method,
    url: path,
    headers: {
      host: "127.0.0.1:3000",
      ...(jsonBody ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  }) as unknown as IncomingMessage;
}

function postJsonRequest(
  path: string,
  headers: Record<string, string>,
  jsonBody: string,
): IncomingMessage {
  return mutationRequest("POST", path, headers, jsonBody);
}

function postMaintenanceRequest(
  headers: Record<string, string>,
  jsonBody = '{"enabled":false}',
): IncomingMessage {
  return postJsonRequest("/maintenance", headers, jsonBody);
}

async function issuedHumanMutationNonce(
  action = "maintenance-mode",
  now = Date.now(),
) {
  const nonceResponse = issueHumanMutationNonce(
    new Request(`${MAINTENANCE_ORIGIN}/human-session`, {
      headers: {
        host: "127.0.0.1:3000",
        referer: `${MAINTENANCE_ORIGIN}/`,
        "sec-fetch-site": "same-origin",
      },
    }),
    now,
  );
  const payload = (await nonceResponse.json()) as { nonce: string };
  return {
    nonce: payload.nonce,
    cookie: nonceResponse.headers.get("set-cookie")!.split(";")[0],
    action,
  };
}

async function issuedMaintenanceNonce(now = Date.now()) {
  return issuedHumanMutationNonce("maintenance-mode", now);
}

function authorizedHumanHeaders(
  nonce: string,
  cookie: string,
  action: string,
) {
  return {
    origin: MAINTENANCE_ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-multiagents-human-action": action,
    "x-multiagents-human-nonce": nonce,
    cookie,
  };
}

describe("daemon HTTP router", () => {
  it("rejects review flow POST without the human mutation gate", async () => {
    const applyReviewFlowMutation = vi.fn(async () => ({
      flowId: "flow-1",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyReviewFlowMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/flows/review", {}, '{"prompt":"Review this"}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyReviewFlowMutation).not.toHaveBeenCalled();
  });

  it("accepts review flow POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("review-run");
    const payload = { flowId: "flow-1", steps: [{ stepId: "s1" }] };
    const applyReviewFlowMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyReviewFlowMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/flows/review",
        authorizedHumanHeaders(nonce, cookie, "review-run"),
        '{"prompt":"Review this"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyReviewFlowMutation).toHaveBeenCalledWith(
      { prompt: "Review this" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects review rerun POST without the human mutation gate", async () => {
    const prepareReviewRerun = vi.fn(async () => ({
      kind: "stream",
      stream: new ReadableStream(),
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ prepareReviewRerun }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/flows/review/rerun",
        {},
        '{"taskId":"00000000-0000-4000-8000-000000000001","stepId":"codex_draft"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(prepareReviewRerun).not.toHaveBeenCalled();
  });

  it("accepts review rerun POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("review-rerun");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: test\n\n"));
        controller.close();
      },
    });
    const prepareReviewRerun = vi.fn(async () => ({
      kind: "stream",
      stream,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ prepareReviewRerun }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/flows/review/rerun",
        authorizedHumanHeaders(nonce, cookie, "review-rerun"),
        '{"taskId":"00000000-0000-4000-8000-000000000001","stepId":"codex_draft"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(prepareReviewRerun).toHaveBeenCalledTimes(1);
  });

  it("rejects review flow stream POST without the human mutation gate", async () => {
    const prepareReviewFlowStream = vi.fn(async () => ({
      kind: "stream",
      stream: new ReadableStream(),
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ prepareReviewFlowStream }),
    );
    const output = response();

    await handler(
      postJsonRequest("/flows/review/stream", {}, '{"prompt":"Review this"}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(prepareReviewFlowStream).not.toHaveBeenCalled();
  });

  it("accepts review flow stream POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("review-run");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: test\n\n"));
        controller.close();
      },
    });
    const prepareReviewFlowStream = vi.fn(async () => ({
      kind: "stream",
      stream,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ prepareReviewFlowStream }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/flows/review/stream",
        authorizedHumanHeaders(nonce, cookie, "review-run"),
        '{"prompt":"Review this"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(prepareReviewFlowStream).toHaveBeenCalledTimes(1);
  });

  it("rejects agent run POST without the human mutation gate", async () => {
    const applyAgentRunMutation = vi.fn(async () => ({
      status: "completed",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyAgentRunMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/agents/codex", {}, '{"prompt":"hello"}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyAgentRunMutation).not.toHaveBeenCalled();
  });

  it("accepts agent run POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("agent-run");
    const payload = { status: "completed", output: "analysis" };
    const applyAgentRunMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyAgentRunMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/agents/codex",
        authorizedHumanHeaders(nonce, cookie, "agent-run"),
        '{"prompt":"hello"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyAgentRunMutation).toHaveBeenCalledWith(
      "codex",
      { prompt: "hello" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects parallel agent run POST without the human mutation gate", async () => {
    const applyAgentParallelRunMutation = vi.fn(async () => ({
      results: [],
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyAgentParallelRunMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/agents/parallel", {}, '{"prompt":"hello"}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyAgentParallelRunMutation).not.toHaveBeenCalled();
  });

  it("accepts parallel agent run POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("agent-run");
    const payload = {
      results: [
        { status: "completed", output: "a" },
        { status: "completed", output: "b" },
      ],
    };
    const applyAgentParallelRunMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyAgentParallelRunMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/agents/parallel",
        authorizedHumanHeaders(nonce, cookie, "agent-run"),
        '{"prompt":"hello"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyAgentParallelRunMutation).toHaveBeenCalledWith(
      { prompt: "hello" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("serves human session through the core human-session boundary", async () => {
    const webResponse = Response.json(
      { nonce: "nonce-1", expiresAt: "2026-01-01T00:02:00.000Z" },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": "multiagents_human_session=abc; HttpOnly",
        },
      },
    );
    const issueHumanSession = vi.fn(() => webResponse) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ issueHumanSession }),
    );
    const output = response();
    const incoming = request("GET", "/human-session");
    incoming.headers.referer = "http://127.0.0.1:3000/";
    incoming.headers["sec-fetch-site"] = "same-origin";

    await handler(incoming, output.value);

    expect(output.status()).toBe(200);
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.header("set-cookie")).toContain("multiagents_human_session=abc");
    expect(output.json()).toEqual({
      nonce: "nonce-1",
      expiresAt: "2026-01-01T00:02:00.000Z",
    });
    expect(issueHumanSession).toHaveBeenCalledTimes(1);
  });

  it("forwards human session gate failures from the shared issuer", async () => {
    const issueHumanSession = vi.fn(() => Response.json(
      { error: "A same-origin UI session is required" },
      { status: 403 },
    )) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ issueHumanSession }),
    );
    const output = response();

    await handler(request("GET", "/human-session"), output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "A same-origin UI session is required",
    });
  });

  it("does not expose human session on unsupported methods", async () => {
    const issueHumanSession = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ issueHumanSession }),
    );
    const output = response();

    await handler(request("POST", "/human-session"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(issueHumanSession).not.toHaveBeenCalled();
  });

  it("does not expose agent execution routes as daemon reads", async () => {
    const handler = createDaemonHttpHandler(dependencies());
    const output = response();

    await handler(request("GET", "/agents/codex"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
  });

  it("serves maintenance state through the core maintenance-state boundary", async () => {
    const payload = { state: "MAINTENANCE" };
    const loadMaintenanceState = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadMaintenanceState }),
    );
    const output = response();

    await handler(request("GET", "/maintenance"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadMaintenanceState).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when maintenance state loading fails", async () => {
    const loadMaintenanceState = vi.fn(() => {
      throw new Error("registry failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadMaintenanceState }),
    );
    const output = response();

    await handler(request("GET", "/maintenance"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "maintenance_state_failed" });
  });

  it("rejects maintenance POST without the human mutation gate", async () => {
    const applyMaintenanceMutation = vi.fn(async () => ({
      state: "RUNNING",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyMaintenanceMutation }),
    );
    const output = response();

    await handler(postMaintenanceRequest({}), output.value);

    expect(output.status()).toBe(403);
    expect(applyMaintenanceMutation).not.toHaveBeenCalled();
  });

  it("accepts maintenance POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedMaintenanceNonce();
    const applyMaintenanceMutation = vi.fn(async () => ({
      state: "RUNNING",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyMaintenanceMutation }),
    );
    const output = response();

    await handler(
      postMaintenanceRequest(
        authorizedHumanHeaders(nonce, cookie, "maintenance-mode"),
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual({ state: "RUNNING" });
    expect(applyMaintenanceMutation).toHaveBeenCalledWith({ enabled: false });
  });

  it("serves state backups through the core state-backups boundary", async () => {
    const payload = {
      backups: [{ backupId: "b-1" }],
      latest: { backupId: "b-1", verified: true },
    };
    const loadStateBackups = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadStateBackups }),
    );
    const output = response();

    await handler(request("GET", "/state/backups"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadStateBackups).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when state backup listing fails", async () => {
    const loadStateBackups = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadStateBackups }),
    );
    const output = response();

    await handler(request("GET", "/state/backups"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "state_backups_failed" });
  });

  it("rejects state backup create POST without the human mutation gate", async () => {
    const createStateBackup = vi.fn(async () => ({
      backup: { backupId: "b-new" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ createStateBackup }),
    );
    const output = response();

    await handler(
      postJsonRequest("/state/backups", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(createStateBackup).not.toHaveBeenCalled();
  });

  it("accepts state backup create POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("state-backup");
    const backupPayload = {
      backup: { backupId: "b-new", verified: false },
    };
    const createStateBackup = vi.fn(async () => backupPayload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ createStateBackup }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/state/backups",
        authorizedHumanHeaders(nonce, cookie, "state-backup"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(201);
    expect(output.json()).toEqual(backupPayload);
    expect(createStateBackup).toHaveBeenCalledTimes(1);
  });

  it("serves state backup validate through the core validate boundary", async () => {
    const payload = {
      backup: { backupId: "b-1", verified: true },
    };
    const loadStateBackupValidate = vi.fn(() => payload) as never;
    const loadStateBackups = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadStateBackupValidate, loadStateBackups }),
    );
    const output = response();

    await handler(request("GET", "/state/backups/b-1/validate"), output.value);

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(loadStateBackupValidate).toHaveBeenCalledWith("b-1");
    expect(loadStateBackups).not.toHaveBeenCalled();
  });

  it("maps backup validation client errors to 400", async () => {
    const { BackupValidationError } = await import("../server/state-backup");
    const loadStateBackupValidate = vi.fn(() => {
      throw new BackupValidationError("Backup metadata not found");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadStateBackupValidate }),
    );
    const output = response();

    await handler(request("GET", "/state/backups/b-1/validate"), output.value);

    expect(output.status()).toBe(400);
    expect(output.json()).toEqual({ error: "Backup metadata not found" });
  });

  it("rejects backup validate POST without the human mutation gate", async () => {
    const loadStateBackupValidate = vi.fn(() => ({
      backup: { backupId: "b-1", verified: true },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadStateBackupValidate }),
    );
    const output = response();

    await handler(
      postJsonRequest("/state/backups/b-1/validate", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(loadStateBackupValidate).not.toHaveBeenCalled();
  });

  it("accepts backup validate POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce(
      "state-backup-validate",
    );
    const payload = { backup: { backupId: "b-1", verified: true } };
    const loadStateBackupValidate = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadStateBackupValidate }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/state/backups/b-1/validate",
        authorizedHumanHeaders(nonce, cookie, "state-backup-validate"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(loadStateBackupValidate).toHaveBeenCalledWith("b-1");
  });

  it("rejects a non-loopback Host header on state backups", async () => {
    const loadStateBackups = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadStateBackups }),
    );
    const output = response();
    const incoming = request("GET", "/state/backups");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadStateBackups).not.toHaveBeenCalled();
  });

  it("serves outbound Slack settings through the core outbound-slack-settings boundary", async () => {
    const payload = {
      configured: true,
      config: { enabled: true, taskFailed: true },
    };
    const loadOutboundSlackSettings = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOutboundSlackSettings }),
    );
    const output = response();

    await handler(request("GET", "/outbound/slack/settings"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadOutboundSlackSettings).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when outbound Slack settings loading fails", async () => {
    const loadOutboundSlackSettings = vi.fn(() => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOutboundSlackSettings }),
    );
    const output = response();

    await handler(request("GET", "/outbound/slack/settings"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "outbound_slack_settings_failed" });
  });

  it("rejects outbound Slack settings POST without the human mutation gate", async () => {
    const applyOutboundSlackSettingsMutation = vi.fn(() => ({
      configured: true,
      config: { enabled: true },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyOutboundSlackSettingsMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/outbound/slack/settings",
        {},
        '{"enabled":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyOutboundSlackSettingsMutation).not.toHaveBeenCalled();
  });

  it("accepts outbound Slack settings POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce(
      "outbound-preferences",
    );
    const payload = {
      configured: true,
      config: { enabled: true, webhookUrl: "https://hooks.example" },
    };
    const applyOutboundSlackSettingsMutation = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyOutboundSlackSettingsMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/outbound/slack/settings",
        authorizedHumanHeaders(nonce, cookie, "outbound-preferences"),
        '{"enabled":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyOutboundSlackSettingsMutation).toHaveBeenCalledWith({
      enabled: true,
    });
  });

  it("does not treat outbound Slack test as settings read", async () => {
    const loadOutboundSlackSettings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOutboundSlackSettings }),
    );
    const output = response();

    await handler(request("GET", "/outbound/slack/test"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadOutboundSlackSettings).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on outbound Slack settings", async () => {
    const loadOutboundSlackSettings = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadOutboundSlackSettings }),
    );
    const output = response();
    const incoming = request("GET", "/outbound/slack/settings");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadOutboundSlackSettings).not.toHaveBeenCalled();
  });

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

  it("rejects repository profile POST without the human mutation gate", async () => {
    const applyRepoProfileMutation = vi.fn(async () => ({
      profile: { repoId: "repo-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyRepoProfileMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/repos/repo-1/profile",
        {},
        '{"confirmation":true,"name":"safe_default","enabled":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyRepoProfileMutation).not.toHaveBeenCalled();
  });

  it("accepts repository profile POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("profile-save");
    const payload = {
      profile: { repoId: "repo-1", profileId: "safe_default" },
    };
    const applyRepoProfileMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyRepoProfileMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/repos/repo-1/profile",
        authorizedHumanHeaders(nonce, cookie, "profile-save"),
        '{"confirmation":true,"name":"safe_default","enabled":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyRepoProfileMutation).toHaveBeenCalledWith("repo-1", {
      confirmation: true,
      name: "safe_default",
      enabled: true,
    });
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

  it("rejects repository templates POST without the human mutation gate", async () => {
    const applyRepoTemplatesMutation = vi.fn(async () => ({
      templates: [],
      settings: { defaultTemplateId: "bug_fix" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyRepoTemplatesMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/repos/repo-1/templates",
        {},
        '{"confirmation":true,"templateId":"bug_fix","enabled":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyRepoTemplatesMutation).not.toHaveBeenCalled();
  });

  it("accepts repository templates POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("template-save");
    const payload = {
      templates: [{ templateId: "bug_fix", enabled: true }],
      settings: { defaultTemplateId: "bug_fix" },
    };
    const applyRepoTemplatesMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyRepoTemplatesMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/repos/repo-1/templates",
        authorizedHumanHeaders(nonce, cookie, "template-save"),
        '{"confirmation":true,"templateId":"bug_fix","enabled":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyRepoTemplatesMutation).toHaveBeenCalledWith("repo-1", {
      confirmation: true,
      templateId: "bug_fix",
      enabled: true,
    });
  });

  it("does not treat repository pulls as repository templates", async () => {
    const loadRepoTemplates = vi.fn() as never;
    const loadRepoPulls = vi.fn(async () => ({ pulls: [] })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoTemplates, loadRepoPulls }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/pulls"), output.value);

    expect(output.status()).toBe(200);
    expect(loadRepoTemplates).not.toHaveBeenCalled();
    expect(loadRepoPulls).toHaveBeenCalledWith("repo-1");
  });

  it("serves repository pulls through the core repo-pulls boundary", async () => {
    const payload = { pulls: [{ number: 42, title: "Fix bug" }] };
    const loadRepoPulls = vi.fn(async () => payload) as never;
    const loadRepoProfile = vi.fn() as never;
    const loadRepoTemplates = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoPulls, loadRepoProfile, loadRepoTemplates }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/pulls"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual(payload);
    expect(loadRepoPulls).toHaveBeenCalledWith("repo-1");
    expect(loadRepoProfile).not.toHaveBeenCalled();
    expect(loadRepoTemplates).not.toHaveBeenCalled();
  });

  it("returns 400 when repository pull listing fails", async () => {
    const loadRepoPulls = vi.fn(async () => {
      throw new RepoPullsRequestError("Repository not found");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoPulls }),
    );
    const output = response();

    await handler(request("GET", "/repos/missing/pulls"), output.value);

    expect(output.status()).toBe(400);
    expect(output.json()).toEqual({ error: "Repository not found" });
  });

  it("returns a stable error when repository pulls loading fails unexpectedly", async () => {
    const loadRepoPulls = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoPulls }),
    );
    const output = response();

    await handler(request("GET", "/repos/repo-1/pulls"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "repo_pulls_failed" });
  });

  it("does not expose repository pulls on unsupported methods", async () => {
    const loadRepoPulls = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoPulls }),
    );
    const output = response();

    await handler(request("POST", "/repos/repo-1/pulls"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadRepoPulls).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host header on repository pulls", async () => {
    const loadRepoPulls = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadRepoPulls }),
    );
    const output = response();
    const incoming = request("GET", "/repos/repo-1/pulls");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
    expect(loadRepoPulls).not.toHaveBeenCalled();
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

  it("rejects cleanup preview POST without the human mutation gate", async () => {
    const applyCleanupPreviewMutation = vi.fn(async () => ({
      selected: [],
      estimatedBytes: 0,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyCleanupPreviewMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/cleanup/preview", {}, '{"candidateIds":[]}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyCleanupPreviewMutation).not.toHaveBeenCalled();
  });

  it("accepts cleanup preview POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("cleanup-preview");
    const previewPayload = {
      selected: [{ id: "notification:n-1" }],
      estimatedBytes: 10,
    };
    const applyCleanupPreviewMutation = vi.fn(async () => previewPayload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyCleanupPreviewMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/cleanup/preview",
        authorizedHumanHeaders(nonce, cookie, "cleanup-preview"),
        '{"candidateIds":["notification:n-1"]}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(previewPayload);
    expect(applyCleanupPreviewMutation).toHaveBeenCalledWith({
      candidateIds: ["notification:n-1"],
    });
  });

  it("rejects cleanup execute POST without the human mutation gate", async () => {
    const applyCleanupExecuteMutation = vi.fn(async () => ({
      completed: [],
      estimatedBytes: 0,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyCleanupExecuteMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/cleanup/execute", {}, '{"candidateIds":[]}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyCleanupExecuteMutation).not.toHaveBeenCalled();
  });

  it("accepts cleanup execute POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("cleanup-execute");
    const executePayload = {
      completed: ["notification:n-1"],
      estimatedBytes: 10,
    };
    const applyCleanupExecuteMutation = vi.fn(async () => executePayload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyCleanupExecuteMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/cleanup/execute",
        authorizedHumanHeaders(nonce, cookie, "cleanup-execute"),
        '{"candidateIds":["notification:n-1"]}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(executePayload);
    expect(applyCleanupExecuteMutation).toHaveBeenCalledWith({
      candidateIds: ["notification:n-1"],
    });
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

  it("rejects retention policy POST without the human mutation gate", async () => {
    const applyRetentionPolicyMutation = vi.fn(() => ({
      preset: "balanced",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyRetentionPolicyMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/retention-policy", {}, '{"preset":"balanced"}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyRetentionPolicyMutation).not.toHaveBeenCalled();
  });

  it("accepts retention policy POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("retention-policy");
    const applyRetentionPolicyMutation = vi.fn(() => ({
      preset: "balanced",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyRetentionPolicyMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/retention-policy",
        authorizedHumanHeaders(nonce, cookie, "retention-policy"),
        '{"preset":"balanced"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual({ preset: "balanced" });
    expect(applyRetentionPolicyMutation).toHaveBeenCalledWith({
      preset: "balanced",
    });
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

  it("rejects notification preferences POST without the human mutation gate", async () => {
    const applyNotificationPreferencesMutation = vi.fn(() => ({
      preferences: { taskInactive: true },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationPreferencesMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notification-preferences",
        {},
        '{"taskInactive":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyNotificationPreferencesMutation).not.toHaveBeenCalled();
  });

  it("accepts notification preferences POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce(
      "notification-preferences",
    );
    const payload = { preferences: { taskInactive: false } };
    const applyNotificationPreferencesMutation = vi.fn(() => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationPreferencesMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notification-preferences",
        authorizedHumanHeaders(nonce, cookie, "notification-preferences"),
        '{"taskInactive":false}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyNotificationPreferencesMutation).toHaveBeenCalledWith({
      taskInactive: false,
    });
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

  it("rejects notification read POST without the human mutation gate", async () => {
    const applyNotificationReadMutation = vi.fn(() => ({
      notificationId: "n-1",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationReadMutation }),
    );
    const output = response();

    await handler(postJsonRequest("/notifications/n-1/read", {}, ""), output.value);

    expect(output.status()).toBe(403);
    expect(applyNotificationReadMutation).not.toHaveBeenCalled();
  });

  it("accepts notification read POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("notification-read");
    const notification = { notificationId: "n-1", status: "read" };
    const applyNotificationReadMutation = vi.fn(() => notification) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationReadMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/read",
        authorizedHumanHeaders(nonce, cookie, "notification-read"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual({ notification });
    expect(applyNotificationReadMutation).toHaveBeenCalledWith("n-1");
  });

  it("returns not found when notification read misses", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("notification-read");
    const applyNotificationReadMutation = vi.fn(() => undefined);
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationReadMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/read",
        authorizedHumanHeaders(nonce, cookie, "notification-read"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Notification not found" });
  });

  it("rejects notification slack delivery dismiss POST without the human mutation gate", async () => {
    const applyNotificationSlackDeliveryDismissMutation = vi.fn(() => ({
      delivery: { deliveryId: "d-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationSlackDeliveryDismissMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/deliveries/slack/dismiss",
        {},
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyNotificationSlackDeliveryDismissMutation).not.toHaveBeenCalled();
  });

  it("accepts notification slack delivery dismiss POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("outbound-dismiss");
    const payload = { delivery: { deliveryId: "d-1", status: "suppressed" } };
    const applyNotificationSlackDeliveryDismissMutation = vi.fn(
      () => payload,
    ) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationSlackDeliveryDismissMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/deliveries/slack/dismiss",
        authorizedHumanHeaders(nonce, cookie, "outbound-dismiss"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyNotificationSlackDeliveryDismissMutation).toHaveBeenCalledWith(
      "n-1",
    );
  });

  it("does not treat slack delivery dismiss as notification dismiss", async () => {
    const applyNotificationDismissMutation = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationDismissMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/notifications/n-1/deliveries/slack/dismiss", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyNotificationDismissMutation).not.toHaveBeenCalled();
  });

  it("rejects notification slack mark-delivered POST without the human mutation gate", async () => {
    const applyNotificationSlackMarkDeliveredMutation = vi.fn(() => ({
      delivery: { deliveryId: "d-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationSlackMarkDeliveredMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/deliveries/slack/mark-delivered",
        {},
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyNotificationSlackMarkDeliveredMutation).not.toHaveBeenCalled();
  });

  it("accepts notification slack mark-delivered POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce(
      "outbound-mark-delivered",
    );
    const payload = { delivery: { deliveryId: "d-1", status: "delivered" } };
    const applyNotificationSlackMarkDeliveredMutation = vi.fn(
      () => payload,
    ) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationSlackMarkDeliveredMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/deliveries/slack/mark-delivered",
        authorizedHumanHeaders(nonce, cookie, "outbound-mark-delivered"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyNotificationSlackMarkDeliveredMutation).toHaveBeenCalledWith(
      "n-1",
    );
  });

  it("rejects notification slack retry POST without the human mutation gate", async () => {
    const applyNotificationSlackRetryMutation = vi.fn(async () => ({
      delivery: { deliveryId: "d-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationSlackRetryMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/notifications/n-1/deliveries/slack/retry", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyNotificationSlackRetryMutation).not.toHaveBeenCalled();
  });

  it("accepts notification slack retry POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("outbound-retry");
    const payload = { delivery: { deliveryId: "d-1", status: "delivered" } };
    const applyNotificationSlackRetryMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationSlackRetryMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/deliveries/slack/retry",
        authorizedHumanHeaders(nonce, cookie, "outbound-retry"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyNotificationSlackRetryMutation).toHaveBeenCalledWith("n-1");
  });

  it("rejects notification read-all POST without the human mutation gate", async () => {
    const applyNotificationReadAllMutation = vi.fn(() => ({ updated: 1 })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationReadAllMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/notifications/read-all", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyNotificationReadAllMutation).not.toHaveBeenCalled();
  });

  it("accepts notification read-all POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce(
      "notification-read-all",
    );
    const applyNotificationReadAllMutation = vi.fn(() => ({ updated: 4 })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationReadAllMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/read-all",
        authorizedHumanHeaders(nonce, cookie, "notification-read-all"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual({ updated: 4 });
    expect(applyNotificationReadAllMutation).toHaveBeenCalledTimes(1);
  });

  it("does not expose notification read-all on unsupported methods", async () => {
    const applyNotificationReadAllMutation = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationReadAllMutation }),
    );
    const output = response();

    await handler(request("GET", "/notifications/read-all"), output.value);

    expect(output.status()).toBe(404);
    expect(applyNotificationReadAllMutation).not.toHaveBeenCalled();
  });

  it("rejects notification dismiss POST without the human mutation gate", async () => {
    const applyNotificationDismissMutation = vi.fn(() => ({
      notificationId: "n-1",
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationDismissMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/notifications/n-1/dismiss", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyNotificationDismissMutation).not.toHaveBeenCalled();
  });

  it("accepts notification dismiss POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce(
      "notification-dismiss",
    );
    const notification = { notificationId: "n-1", status: "dismissed" };
    const applyNotificationDismissMutation = vi.fn(() => notification) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyNotificationDismissMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/notifications/n-1/dismiss",
        authorizedHumanHeaders(nonce, cookie, "notification-dismiss"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual({ notification });
    expect(applyNotificationDismissMutation).toHaveBeenCalledWith("n-1");
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

  it("rejects task create POST without the human mutation gate", async () => {
    const createTaskFromBody = vi.fn(async () => ({
      task: { id: "task-new" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ createTaskFromBody }),
    );
    const output = response();

    await handler(
      postJsonRequest("/tasks", {}, '{"repoId":"repo-1"}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(createTaskFromBody).not.toHaveBeenCalled();
  });

  it("accepts task create POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("task-create");
    const initializeTaskRecovery = vi.fn(async () => undefined) as never;
    const createTaskFromBody = vi.fn(async () => ({
      task: { id: "task-new", repoId: "repo-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ initializeTaskRecovery, createTaskFromBody }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks",
        authorizedHumanHeaders(nonce, cookie, "task-create"),
        '{"repoId":"repo-1","templateId":"bug_fix","prompt":"Fix"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(201);
    expect(output.json()).toEqual({
      task: { id: "task-new", repoId: "repo-1" },
    });
    expect(initializeTaskRecovery).toHaveBeenCalledTimes(1);
    expect(createTaskFromBody).toHaveBeenCalledWith({
      repoId: "repo-1",
      templateId: "bug_fix",
      prompt: "Fix",
    });
  });

  it("does not expose task listing on unsupported methods", async () => {
    const listTasks = vi.fn(async () => []) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("DELETE", "/tasks"), output.value);

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

  it("rejects task create-pr POST without the human mutation gate", async () => {
    const applyTaskCreatePrMutation = vi.fn(async () => ({
      task: { id: "task-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskCreatePrMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/tasks/task-1/create-pr", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyTaskCreatePrMutation).not.toHaveBeenCalled();
  });

  it("accepts task create-pr POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("task-create-pr");
    const payload = { task: { id: "task-1", prNumber: 42 } };
    const applyTaskCreatePrMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskCreatePrMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/create-pr",
        authorizedHumanHeaders(nonce, cookie, "task-create-pr"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyTaskCreatePrMutation).toHaveBeenCalledWith("task-1");
  });

  it("rejects task prepare-approval POST without the human mutation gate", async () => {
    const applyTaskPrepareApprovalMutation = vi.fn(async () => ({
      status: 200,
      body: {},
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskPrepareApprovalMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/tasks/task-1/prepare-approval", {}, ""),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyTaskPrepareApprovalMutation).not.toHaveBeenCalled();
  });

  it("accepts task prepare-approval POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce(
      "task-prepare-approval",
    );
    const payload = {
      status: 200,
      body: {
        diff: { approvable: true },
        approval: { approvalId: "ap-1" },
        task: { id: "task-1" },
      },
    };
    const applyTaskPrepareApprovalMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskPrepareApprovalMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/prepare-approval",
        authorizedHumanHeaders(nonce, cookie, "task-prepare-approval"),
        "",
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload.body);
    expect(applyTaskPrepareApprovalMutation).toHaveBeenCalledWith("task-1");
  });

  it("rejects task apply-review POST without the human mutation gate", async () => {
    const applyTaskApplyReviewMutation = vi.fn(async () => ({
      task: { id: "task-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskApplyReviewMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/apply-review",
        {},
        '{"approved":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyTaskApplyReviewMutation).not.toHaveBeenCalled();
  });

  it("accepts task apply-review POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("task-apply-review");
    const payload = { task: { id: "task-1", status: "open" } };
    const applyTaskApplyReviewMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskApplyReviewMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/apply-review",
        authorizedHumanHeaders(nonce, cookie, "task-apply-review"),
        '{"approved":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyTaskApplyReviewMutation).toHaveBeenCalledWith("task-1", {
      approved: true,
    });
  });

  it("rejects task approve-rework POST without the human mutation gate", async () => {
    const applyTaskApproveReworkMutation = vi.fn(async () => ({
      task: { id: "task-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskApproveReworkMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/approve-rework",
        {},
        '{"approved":true,"diffHash":"abc","approvalId":"ap-1"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyTaskApproveReworkMutation).not.toHaveBeenCalled();
  });

  it("accepts task approve-rework POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("task-approve-rework");
    const payload = { task: { id: "task-1", status: "rework" } };
    const applyTaskApproveReworkMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskApproveReworkMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/approve-rework",
        authorizedHumanHeaders(nonce, cookie, "task-approve-rework"),
        '{"approved":true,"diffHash":"abc","approvalId":"ap-1"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyTaskApproveReworkMutation).toHaveBeenCalledWith("task-1", {
      approved: true,
      diffHash: "abc",
      approvalId: "ap-1",
    });
  });

  it("rejects task approve POST without the human mutation gate", async () => {
    const applyTaskApproveMutation = vi.fn(async () => ({
      task: { id: "task-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskApproveMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/approve",
        {},
        '{"approved":true,"diffHash":"abc","approvalId":"ap-1"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyTaskApproveMutation).not.toHaveBeenCalled();
  });

  it("accepts task approve POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("task-approve");
    const payload = { task: { id: "task-1", prNumber: 42 } };
    const applyTaskApproveMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskApproveMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/approve",
        authorizedHumanHeaders(nonce, cookie, "task-approve"),
        '{"approved":true,"diffHash":"abc","approvalId":"ap-1"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyTaskApproveMutation).toHaveBeenCalledWith("task-1", {
      approved: true,
      diffHash: "abc",
      approvalId: "ap-1",
    });
  });

  it("rejects task delete without the human mutation gate", async () => {
    const removeTask = vi.fn(async () => undefined) as never;
    const handler = createDaemonHttpHandler(dependencies({ removeTask }));
    const output = response();

    await handler(
      mutationRequest("DELETE", "/tasks/task-1", {}),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(removeTask).not.toHaveBeenCalled();
  });

  it("accepts task delete after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("task-delete");
    const initializeTaskDeleteRecovery = vi.fn(async () => undefined) as never;
    const parseTaskDeleteBody = vi.fn(() => ({ confirmedPrCleanup: true })) as never;
    const removeTask = vi.fn(async () => undefined) as never;
    const handler = createDaemonHttpHandler(
      dependencies({
        initializeTaskDeleteRecovery,
        parseTaskDeleteBody,
        removeTask,
      }),
    );
    const output = response();

    await handler(
      mutationRequest(
        "DELETE",
        "/tasks/task-1",
        authorizedHumanHeaders(nonce, cookie, "task-delete"),
        '{"confirmedPrCleanup":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(204);
    expect(initializeTaskDeleteRecovery).toHaveBeenCalledTimes(1);
    expect(parseTaskDeleteBody).toHaveBeenCalledWith(
      '{"confirmedPrCleanup":true}',
    );
    expect(removeTask).toHaveBeenCalledWith("task-1", {
      confirmedPrCleanup: true,
    });
  });

  it("does not expose unsupported task detail mutations", async () => {
    const loadTaskDetail = vi.fn(async () => ({
      task: { id: "task-1" },
      diff: { patch: "" },
      conflict: false as const,
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadTaskDetail }),
    );
    const output = response();

    await handler(request("POST", "/tasks/task-1"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
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

  it("rejects findings extract POST without the human mutation gate", async () => {
    const applyTaskFindingsExtractMutation = vi.fn(async () => ({
      findings: [],
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskFindingsExtractMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/findings/extract",
        {},
        '{"confirmed":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyTaskFindingsExtractMutation).not.toHaveBeenCalled();
  });

  it("accepts findings extract POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("finding-extract");
    const payload = { findings: [{ findingId: "f-1", title: "Bug" }] };
    const applyTaskFindingsExtractMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyTaskFindingsExtractMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/tasks/task-1/findings/extract",
        authorizedHumanHeaders(nonce, cookie, "finding-extract"),
        '{"confirmed":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(201);
    expect(output.json()).toEqual(payload);
    expect(applyTaskFindingsExtractMutation).toHaveBeenCalledWith("task-1", {
      confirmed: true,
    });
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

  it("rejects finding accept POST without the human mutation gate", async () => {
    const applyFindingAcceptMutation = vi.fn(async () => ({
      finding: { findingId: "f-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingAcceptMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/accept",
        {},
        '{"confirmed":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyFindingAcceptMutation).not.toHaveBeenCalled();
  });

  it("accepts finding accept POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("finding-accept");
    const payload = {
      finding: { findingId: "f-1", status: "accepted" },
      remediation: { findingId: "f-1" },
      history: [{ type: "finding_accepted" }],
    };
    const applyFindingAcceptMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingAcceptMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/accept",
        authorizedHumanHeaders(nonce, cookie, "finding-accept"),
        '{"confirmed":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyFindingAcceptMutation).toHaveBeenCalledWith("f-1", {
      confirmed: true,
    });
  });

  it("does not treat finding accept as findings queue read", async () => {
    const loadFindingsQueue = vi.fn() as never;
    const handler = createDaemonHttpHandler(
      dependencies({ loadFindingsQueue }),
    );
    const output = response();

    await handler(request("GET", "/findings/f-1/accept"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(loadFindingsQueue).not.toHaveBeenCalled();
  });

  it("rejects finding dismiss POST without the human mutation gate", async () => {
    const applyFindingDismissMutation = vi.fn(async () => ({
      finding: { findingId: "f-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingDismissMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/dismiss",
        {},
        '{"confirmed":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyFindingDismissMutation).not.toHaveBeenCalled();
  });

  it("accepts finding dismiss POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("finding-dismiss");
    const payload = {
      finding: { findingId: "f-1", status: "dismissed" },
      remediation: { findingId: "f-1" },
      history: [{ type: "finding_dismissed" }],
    };
    const applyFindingDismissMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingDismissMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/dismiss",
        authorizedHumanHeaders(nonce, cookie, "finding-dismiss"),
        '{"confirmed":true,"reason":"not applicable"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyFindingDismissMutation).toHaveBeenCalledWith("f-1", {
      confirmed: true,
      reason: "not applicable",
    });
  });

  it("rejects finding convert POST without the human mutation gate", async () => {
    const applyFindingConvertMutation = vi.fn(async () => ({
      finding: { findingId: "f-1" },
      task: { id: "task-2" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingConvertMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/convert",
        {},
        '{"confirmed":true,"templateId":"bug_fix","objective":"Fix it"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyFindingConvertMutation).not.toHaveBeenCalled();
  });

  it("accepts finding convert POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("finding-convert");
    const payload = {
      finding: { findingId: "f-1", status: "converted" },
      task: { id: "task-2", repoId: "repo-1" },
      remediation: { findingId: "f-1" },
      history: [{ type: "implementation_task_created" }],
    };
    const applyFindingConvertMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingConvertMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/convert",
        authorizedHumanHeaders(nonce, cookie, "finding-convert"),
        '{"confirmed":true,"templateId":"bug_fix","objective":"Fix it"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(201);
    expect(output.json()).toEqual(payload);
    expect(applyFindingConvertMutation).toHaveBeenCalledWith("f-1", {
      confirmed: true,
      templateId: "bug_fix",
      objective: "Fix it",
    });
  });

  it("rejects finding resolve POST without the human mutation gate", async () => {
    const applyFindingResolveMutation = vi.fn(async () => ({
      finding: { findingId: "f-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingResolveMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest("/findings/f-1/resolve", {}, '{"confirmed":true}'),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyFindingResolveMutation).not.toHaveBeenCalled();
  });

  it("accepts finding resolve POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("finding-resolve");
    const payload = {
      finding: { findingId: "f-1", resolvedAt: "now" },
      remediation: { findingId: "f-1" },
      history: [{ type: "finding_resolved" }],
    };
    const applyFindingResolveMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingResolveMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/resolve",
        authorizedHumanHeaders(nonce, cookie, "finding-resolve"),
        '{"confirmed":true}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyFindingResolveMutation).toHaveBeenCalledWith("f-1", {
      confirmed: true,
    });
  });

  it("rejects finding priority POST without the human mutation gate", async () => {
    const applyFindingPriorityMutation = vi.fn(async () => ({
      finding: { findingId: "f-1" },
    })) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingPriorityMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/priority",
        {},
        '{"confirmed":true,"priority":"urgent"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(403);
    expect(applyFindingPriorityMutation).not.toHaveBeenCalled();
  });

  it("accepts finding priority POST after a daemon human-session nonce", async () => {
    clearHumanMutationSessionsForTests();
    const { nonce, cookie } = await issuedHumanMutationNonce("finding-priority");
    const payload = {
      finding: { findingId: "f-1", humanPriority: "urgent" },
      remediation: { findingId: "f-1" },
      history: [{ type: "finding_priority_changed" }],
    };
    const applyFindingPriorityMutation = vi.fn(async () => payload) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ applyFindingPriorityMutation }),
    );
    const output = response();

    await handler(
      postJsonRequest(
        "/findings/f-1/priority",
        authorizedHumanHeaders(nonce, cookie, "finding-priority"),
        '{"confirmed":true,"priority":"urgent"}',
      ),
      output.value,
    );

    expect(output.status()).toBe(200);
    expect(output.json()).toEqual(payload);
    expect(applyFindingPriorityMutation).toHaveBeenCalledWith("f-1", {
      confirmed: true,
      priority: "urgent",
    });
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
