import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppNotification, NotificationSeverity, NotificationType } from "../notifications/types";
import { defaultOutboundChannelConfig } from "../outbound/types";
import { beginAgentExecution } from "./agent-execution-guard";
import { createCredentialResolver } from "./credential-resolver";
import {
  dispatchOutboundNotification,
  markAmbiguousDelivery,
  parseOutboundChannelConfig,
  reconcileStaleSlackDeliveries,
  retryOutboundNotification,
  sanitizeOutboundNotification,
  sendFixedSlackTest,
} from "./outbound-notifications";
import { issueHumanMutationNonce, rejectNonHumanOutboundMutation } from "./request-security";
import { sendSlackNotification, sendSlackTestNotification, SLACK_TEST_TEXT } from "./slack-adapter";
import { SCHEMA_VERSION, StateStore, replaceStateStoreForTests } from "./state-store";

let store: StateStore;

const webhookUrl = [
  "https://hooks.slack.com/services",
  "T00000000",
  "B00000000",
  "TEST_ONLY_NOT_A_SECRET",
].join("/");


const resolverFor = (value = webhookUrl) => createCredentialResolver({ MULTIAGENTS_SLACK_WEBHOOK_URL: value });

beforeEach(() => { store = new StateStore(":memory:"); replaceStateStoreForTests(store); });
afterEach(() => { replaceStateStoreForTests(new StateStore(":memory:")); });

function create(type: NotificationType, severity: NotificationSeverity = "high", overrides: Partial<AppNotification> = {}) {
  const value = store.createBuiltInNotification({
    type, severity, title: "UNTRUSTED full prompt", message: "agent output and diff /home/alice/project", dedupeKey: `${type}:${crypto.randomUUID()}`,
    repoName: "safe-repository", prNumber: 14, ...overrides,
  });
  if (!value) throw new Error("Test notification was not created");
  return value;
}

describe("Phase 15A outbound sanitizer and policy", () => {
  it("rebuilds fixed content without prompt, output, diff, evidence, review body, absolute paths, or local usernames", () => {
    const internal = {
      ...create("finding_high_created", "high", { repoName: "/home/alice/private-repo" }),
      prompt: "PROMPT_SECRET", output: "OUTPUT_SECRET", diff: "DIFF_SECRET", evidence: "EVIDENCE_SECRET", review: "REVIEW_SECRET",
    } as AppNotification & Record<string, unknown>;
    const payload = sanitizeOutboundNotification(internal);
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["PROMPT_SECRET", "OUTPUT_SECRET", "DIFF_SECRET", "EVIDENCE_SECRET", "REVIEW_SECRET", "/home/alice", "alice", "UNTRUSTED"]) expect(serialized).not.toContain(forbidden);
    expect(payload).toMatchObject({ type: "finding_high_created", title: "High finding created", message: "A high finding requires review.", prNumber: 14 });
    expect(payload.repositoryName).toBeUndefined();
  });

  it.each([
    ["finding_critical_created", "critical"], ["finding_high_created", "high"], ["task_needs_attention", "warning"],
    ["pr_changes_requested", "high"], ["ci_failed", "high"], ["pr_ready_for_human_merge", "info"],
  ] as const)("allows the default important rule %s", async (type, severity) => {
    const notification = create(type, severity);
    const send = vi.fn(async () => ({ delivered: true as const }));
    expect((await dispatchOutboundNotification(notification.notificationId, { configured: true, send })).status).toBe("delivered");
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["task_ready_for_approval", "task_inactive", "worktree_orphaned", "approval_invalidated"] as const)("suppresses %s by default", async (type) => {
    const notification = create(type, "info");
    const send = vi.fn(async () => ({ delivered: true as const }));
    expect(await dispatchOutboundNotification(notification.notificationId, { configured: true, send })).toMatchObject({ status: "suppressed", errorCode: "policy_suppressed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses a missing webhook without failing the internal notification", async () => {
    const notification = create("finding_critical_created", "critical");
    expect(await dispatchOutboundNotification(notification.notificationId, { configured: false })).toMatchObject({ status: "suppressed", errorCode: "not_configured" });
    expect(store.loadNotification(notification.notificationId)).toBeDefined();
  });

  it("blocks duplicate notificationId + channel delivery", async () => {
    const notification = create("ci_failed");
    const send = vi.fn(async () => ({ delivered: true as const }));
    await dispatchOutboundNotification(notification.notificationId, { configured: true, send });
    await dispatchOutboundNotification(notification.notificationId, { configured: true, send });
    expect(send).toHaveBeenCalledOnce();
    expect(store.loadNotificationDeliveries(notification.notificationId)).toHaveLength(1);
  });
});

describe("Phase 15A Slack adapter", () => {
  it("treats 2xx as delivered and sends only the sanitized text body", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => { calls.push(init ?? {}); return new Response("ok", { status: 200 }); };
    const result = await sendSlackNotification(sanitizeOutboundNotification(create("task_needs_attention", "warning")), { resolver: resolverFor(), fetchImpl });
    expect(result).toEqual({ delivered: true });
    const body = String(calls[0].body);
    expect(body).toContain("Open MultiAgents locally for details.");
    expect(body).not.toContain("UNTRUSTED");
  });

  it("treats non-2xx as failed and never persists the response body", async () => {
    const notification = create("ci_failed");
    const fetchImpl = vi.fn(async () => new Response("credential=RESPONSE_BODY_SECRET", { status: 500 }));
    const send = (payload: Parameters<typeof sendSlackNotification>[0]) => sendSlackNotification(payload, { resolver: resolverFor(), fetchImpl });
    const delivery = await dispatchOutboundNotification(notification.notificationId, { configured: true, send });
    expect(delivery).toMatchObject({ status: "failed", errorCode: "http_500" });
    expect(JSON.stringify([delivery, store.loadOutboundAuditEvents()])).not.toContain("RESPONSE_BODY_SECRET");
  });

  it("aborts a timed-out Slack request", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    expect(await sendSlackNotification(sanitizeOutboundNotification(create("ci_failed")), { resolver: resolverFor(), fetchImpl: fetchImpl as typeof fetch, timeoutMs: 5 })).toEqual({ delivered: false, errorCode: "timeout" });
  });

  it("rejects arbitrary and non-Slack webhook hosts before fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const result = await sendSlackNotification(sanitizeOutboundNotification(create("ci_failed")), { resolver: resolverFor("http://127.0.0.1/internal"), fetchImpl });
    expect(result).toEqual({ delivered: false, errorCode: "invalid_credential" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses an immutable, context-free test notification", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => { calls.push(init ?? {}); return new Response("ok"); };
    expect(await sendSlackTestNotification({ resolver: resolverFor(), fetchImpl })).toEqual({ delivered: true });
    const body = String(calls[0].body);
    expect(JSON.parse(body)).toEqual({ text: SLACK_TEST_TEXT });
    for (const forbidden of ["prompt", "repository", "credential", "token", "/home/"]) expect(body.toLowerCase()).not.toContain(forbidden);
  });
});

describe("Phase 15A delivery lifecycle, human gates, and migration", () => {
  it("allows a human-gated retry after failure and records minimal audit events", async () => {
    const notification = create("finding_high_created");
    await dispatchOutboundNotification(notification.notificationId, { configured: true, send: async () => ({ delivered: false, errorCode: "network_error" }) });
    expect((await retryOutboundNotification(notification.notificationId, { configured: true, send: async () => ({ delivered: true }) })).status).toBe("delivered");
    expect(store.loadOutboundAuditEvents().map((event) => (event as { event_type: string }).event_type)).toEqual([
      "outbound_delivery_attempted", "outbound_delivery_failed", "outbound_delivery_retried", "outbound_delivery_attempted", "outbound_delivery_succeeded",
    ]);
  });

  it("requires same-origin human action and blocks agents from retry/test/preferences", async () => {
    const url = "http://localhost:3000/api/outbound/slack/test";
    const direct = new Request(url, { method: "POST", headers: { host: "localhost:3000" } });
    expect(rejectNonHumanOutboundMutation(direct, "outbound-test")?.status).toBe(403);
    const nonceResponse = issueHumanMutationNonce(new Request("http://localhost:3000/api/human-session", { headers: { host: "localhost:3000", referer: "http://localhost:3000/", "sec-fetch-site": "same-origin" } }));
    const nonce = (await nonceResponse.json() as { nonce: string }).nonce;
    const cookie = nonceResponse.headers.get("set-cookie")!.split(";")[0];
    const human = new Request(url, { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-multiagents-human-action": "outbound-test", "x-multiagents-human-nonce": nonce, cookie } });
    expect(rejectNonHumanOutboundMutation(human, "outbound-test")).toBeUndefined();
    const end = beginAgentExecution(); expect(rejectNonHumanOutboundMutation(human, "outbound-test")?.status).toBe(423); end();
  });

  it("persists preferences and deliveries across restart without auto-resending", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-outbound-restart-")); const path = join(root, "state.db");
    const disk = new StateStore(path); replaceStateStoreForTests(disk); store = disk;
    const config = { ...defaultOutboundChannelConfig, sendReadyForApproval: true, channelLabel: "Engineering alerts" };
    store.saveOutboundChannelConfig(config);
    const notification = create("task_ready_for_approval", "info");
    store.reserveNotificationDelivery(notification.notificationId, "pending");
    const reopened = new StateStore(path); replaceStateStoreForTests(reopened); store = reopened;
    expect(store.loadOutboundChannelConfig()).toEqual(config);
    expect(store.loadNotificationDelivery(notification.notificationId)?.status).toBe("pending");
    expect(store.loadOutboundAuditEvents().filter((event) => (event as { event_type: string }).event_type === "outbound_delivery_attempted")).toHaveLength(0);
  });

  it("moves an expired crash-window delivery to ambiguous and never retries automatically", async () => {
    const notification = create("ci_failed");
    const attemptId = crypto.randomUUID();
    store.reserveNotificationDelivery(notification.notificationId, "pending", undefined, {
      attemptId,
      startedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    });
    const operation = store.createOperation({ type: "slack_delivery", notificationId: notification.notificationId, idempotencyKey: `slack_delivery:${notification.notificationId}:${attemptId}`, safeMetadata: { attemptId } });
    store.updateOperation(operation.operationId, "executing");
    const send = vi.fn(async () => ({ delivered: true as const }));

    expect(reconcileStaleSlackDeliveries(new Date("2026-01-01T00:06:00.000Z"))).toBe(1);
    expect(store.loadNotificationDelivery(notification.notificationId)).toMatchObject({ status: "ambiguous", errorCode: "delivery_outcome_unknown" });
    expect(store.loadOperation(operation.operationId)).toMatchObject({ state: "reconcile_required", errorCode: "delivery_outcome_unknown" });
    expect(send).not.toHaveBeenCalled();

    await retryOutboundNotification(notification.notificationId, { configured: true, send });
    expect(send).toHaveBeenCalledOnce();
  });

  it("allows a human decision to mark or dismiss an ambiguous Slack delivery", () => {
    const delivered = create("ci_failed");
    store.reserveNotificationDelivery(delivered.notificationId, "pending");
    reconcileStaleSlackDeliveries();
    expect(markAmbiguousDelivery(delivered.notificationId, "delivered").status).toBe("delivered");

    const dismissed = create("ci_failed");
    store.reserveNotificationDelivery(dismissed.notificationId, "pending");
    reconcileStaleSlackDeliveries();
    expect(markAmbiguousDelivery(dismissed.notificationId, "dismissed")).toMatchObject({ status: "suppressed", errorCode: "human_dismissed" });
  });

  it("migrates v7 to v8 without enqueueing historical notifications", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-outbound-v7-")); const path = join(root, "state.db");
    const initial = new StateStore(path); replaceStateStoreForTests(initial); store = initial;
    const historical = create("finding_critical_created", "critical"); replaceStateStoreForTests();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE credential_audit_events; DROP TABLE outbound_audit_events; DROP TABLE notification_deliveries; DROP TABLE outbound_channel_settings; DELETE FROM schema_version WHERE version >= 8;"); raw.close();
    const migrated = new StateStore(path); replaceStateStoreForTests(migrated); store = migrated;
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.loadNotification(historical.notificationId)).toBeDefined();
    expect(store.loadNotificationDeliveries(historical.notificationId)).toHaveLength(0);
  });

  it("persists validated preferences and audits updates without any webhook value", () => {
    const config = parseOutboundChannelConfig({ ...defaultOutboundChannelConfig, enabled: false, channelLabel: "Security" });
    store.saveOutboundChannelConfig(config);
    expect(store.loadOutboundChannelConfig()).toEqual(config);
    expect(store.loadOutboundAuditEvents()).toContainEqual(expect.objectContaining({ event_type: "outbound_preferences_updated", channel: "slack", status: "suppressed" }));
    expect(JSON.stringify([store.loadOutboundChannelConfig(), store.loadOutboundAuditEvents()])).not.toContain("hooks.slack.com");
  });

  it("audits fixed test delivery without accepting agent or repository content", async () => {
    expect(await sendFixedSlackTest({ configured: true, send: async () => ({ delivered: true }) })).toEqual({ delivered: true });
    expect(store.loadOutboundAuditEvents().map((event) => (event as { event_type: string }).event_type)).toEqual(["outbound_delivery_attempted", "outbound_delivery_succeeded"]);
  });
});
