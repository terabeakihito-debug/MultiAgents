import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "../findings/types";
import { defaultNotificationPreferences, type NotificationQuery } from "../notifications/types";
import { beginAgentExecution } from "./agent-execution-guard";
import { browserNotificationPayload, evaluateFindingNotification, evaluateTaskNotifications, parseNotificationPreferences, parseNotificationQuery } from "./notifications";
import { rejectNonHumanNotificationMutation } from "./request-security";
import { SCHEMA_VERSION, StateStore, replaceStateStoreForTests } from "./state-store";
import type { PullRequestReview } from "./pr-review-types";
import type { RepoTask, TaskStatus } from "./tasks";

let store: StateStore;
const query = (overrides: Partial<NotificationQuery> = {}): NotificationQuery => ({ unreadOnly: false, limit: 100, ...overrides });

function review(headSha: string, overrides: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    number: 14, title: "PR title must not enter notifications", url: "https://github.com/example/repo/pull/14", state: "OPEN", draft: false, merged: false,
    base: "main", head: "multiagents/task", headSha, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", changedFiles: [], checks: [], items: [],
    reviewCount: 0, unresolvedCount: 0, fetchedAt: new Date().toISOString(), ...overrides,
  };
}

function task(status: TaskStatus = "draft", overrides: Partial<RepoTask> = {}): RepoTask {
  const id = overrides.id ?? "11111111-1111-4111-8111-111111111111";
  return {
    id, repoId: "repo", repoName: "Repository", repoPath: "/allowed/repo", allowedRoot: "/allowed", branch: `multiagents/${id}`,
    baseBranch: "main", baseSha: "b".repeat(40), worktreePath: `/worktrees/${id}`, worktreeRoot: "/worktrees", worktreeAvailable: true,
    worktreeStatus: "available", status, prompt: "secret=do-not-notify", reviewReady: false, approvalState: "unavailable", validation: [], secretFindings: [],
    originalTaskAvailable: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoveryStatus: "recoverable", ...overrides,
  };
}

function finding(severity: "critical" | "high", overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: severity === "critical" ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
    sourceTaskId: "11111111-1111-4111-8111-111111111111", title: "credential leaked: ghp_sensitive", summary: "full sensitive detail",
    severity, status: "open", humanPriority: "normal", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  };
}

beforeEach(() => { store = new StateStore(":memory:"); replaceStateStoreForTests(store); });
afterEach(() => { replaceStateStoreForTests(new StateStore(":memory:")); });

describe("Phase 14 built-in watch rules", () => {
  it.each([
    ["critical", "finding_critical_created", "critical"],
    ["high", "finding_high_created", "high"],
  ] as const)("creates a fixed %s finding notification without finding text", (severity, type, expectedSeverity) => {
    const source = task(); store.saveTask(source); const value = finding(severity); store.createFindings([value]);
    evaluateFindingNotification(value);
    expect(store.queryNotifications(query()).notifications[0]).toMatchObject({ type, severity: expectedSeverity, taskId: source.id, findingId: value.findingId });
    expect(JSON.stringify(store.queryNotifications(query()).notifications)).not.toContain("ghp_sensitive");
  });

  it.each([
    ["task_needs_attention", task("review_fetch_failed")],
    ["task_ready_for_approval", task("awaiting_approval", { diffHash: "d".repeat(64) })],
    ["pr_changes_requested", task("awaiting_rework_approval", { prNumber: 14, prReview: review("a".repeat(40)), reviewIntake: { status: "completed", steps: [], requiresRework: true, readyForHumanMerge: false } })],
    ["ci_failed", task("ci_failed", { prNumber: 14, prReview: review("b".repeat(40), { checks: [{ name: "required", state: "FAILURE", bucket: "fail", required: true }] }) })],
    ["pr_ready_for_human_merge", task("ready_for_human_merge", { prNumber: 14, prReview: review("c".repeat(40)), reviewIntake: { status: "completed", steps: [], requiresRework: false, readyForHumanMerge: true } })],
    ["worktree_orphaned", task("draft", { recoveryStatus: "orphaned", worktreeAvailable: false, worktreeStatus: "missing" })],
    ["approval_invalidated", task("approval_invalidated", { diffHash: "e".repeat(64) })],
  ] as const)("evaluates the %s transition", (expected, value) => {
    store.saveTask(value); evaluateTaskNotifications(value);
    expect(store.queryNotifications(query()).notifications.some((item) => item.type === expected)).toBe(true);
  });

  it("evaluates inactive tasks at 72 hours without a scheduler", () => {
    const value = task(); store.saveTask(value);
    evaluateTaskNotifications(value, new Date(Date.parse(value.updatedAt) + 72 * 60 * 60 * 1_000));
    expect(store.queryNotifications(query()).notifications).toMatchObject([{ type: "task_inactive", severity: "info" }]);
  });

  it("deduplicates the same state and re-notifies a failed CI check on a new head", () => {
    const value = task("ci_failed", { prReview: review("a".repeat(40), { checks: [{ name: "required", state: "FAILURE", bucket: "fail", required: true }] }) });
    store.saveTask(value); evaluateTaskNotifications(value); evaluateTaskNotifications(value);
    expect(store.queryNotifications(query({ type: "ci_failed" })).notifications).toHaveLength(1);
    value.status = "review_ready"; value.prReview = review("a".repeat(40)); evaluateTaskNotifications(value);
    value.status = "ci_failed"; value.prReview = review("b".repeat(40), { checks: [{ name: "required", state: "FAILURE", bucket: "fail", required: true }] }); evaluateTaskNotifications(value);
    expect(store.queryNotifications(query({ type: "ci_failed" })).notifications).toHaveLength(2);
  });

  it("notifies Needs Attention once per bucket episode", () => {
    const value = task(); store.saveTask(value);
    value.status = "review_fetch_failed"; value.updatedAt = "2026-01-01T00:00:01.000Z"; evaluateTaskNotifications(value);
    value.status = "validation_failed"; value.updatedAt = "2026-01-01T00:00:02.000Z"; evaluateTaskNotifications(value);
    expect(store.queryNotifications(query({ type: "task_needs_attention" })).notifications).toHaveLength(1);
    value.status = "draft"; value.flowStatus = "running"; evaluateTaskNotifications(value);
    value.status = "pr_failed"; value.flowStatus = "completed"; value.updatedAt = "2026-01-01T00:00:03.000Z"; evaluateTaskNotifications(value);
    expect(store.queryNotifications(query({ type: "task_needs_attention" })).notifications).toHaveLength(2);
  });

  it("honors disabled preferences and creates on a later enabled evaluation", () => {
    store.saveNotificationPreferences({ ...defaultNotificationPreferences, ciFailed: false });
    const value = task("ci_failed", { prReview: review("a".repeat(40)) }); store.saveTask(value); evaluateTaskNotifications(value);
    expect(store.queryNotifications(query({ type: "ci_failed" })).notifications).toHaveLength(0);
    store.saveNotificationPreferences(defaultNotificationPreferences); evaluateTaskNotifications(value);
    expect(store.queryNotifications(query({ type: "ci_failed" })).notifications).toHaveLength(1);
  });
});

describe("Phase 14 notification persistence and security", () => {
  function seed() {
    const value = task("awaiting_approval", { diffHash: "a".repeat(64) }); store.saveTask(value); evaluateTaskNotifications(value);
    return store.queryNotifications(query()).notifications[0];
  }

  it("reports unread count, marks one/all read, dismisses, and hides dismissed history", () => {
    const first = seed();
    const secondTask = task("awaiting_approval", { id: "44444444-4444-4444-8444-444444444444", diffHash: "b".repeat(64) }); store.saveTask(secondTask); evaluateTaskNotifications(secondTask);
    expect(store.queryNotifications(query()).unreadCount).toBe(2);
    expect(store.markNotificationRead(first.notificationId)?.status).toBe("read");
    expect(store.queryNotifications(query()).unreadCount).toBe(1);
    expect(store.markAllNotificationsRead()).toBe(1);
    expect(store.dismissNotification(first.notificationId)?.status).toBe("dismissed");
    expect(store.queryNotifications(query()).notifications).toHaveLength(1);
    expect(store.loadNotificationAuditEvents()).toContainEqual(expect.objectContaining(
      { event_type: "notification_created", notification_id: expect.any(String), notification_type: "task_ready_for_approval" },
    ));
  });

  it("persists notifications, preferences, and watch state across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-notifications-")); const path = join(root, "state.db");
    const disk = new StateStore(path); replaceStateStoreForTests(disk); store = disk; const first = seed();
    store.saveNotificationPreferences({ ...defaultNotificationPreferences, inactiveTask: false });
    const reopened = new StateStore(path); replaceStateStoreForTests(reopened); store = reopened;
    expect(store.queryNotifications(query()).notifications[0].notificationId).toBe(first.notificationId);
    expect(store.loadNotificationPreferences().inactiveTask).toBe(false);
    expect(store.loadWatchRuleState("task", first.taskId!, "task_ready_for_approval")?.lastState).toBe("active");
  });

  it("migrates an existing v6 database to v7 without losing tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-v6-")); const path = join(root, "state.db");
    const initial = new StateStore(path); initial.saveTask(task()); initial.close();
    const raw = new DatabaseSync(path); raw.exec("DROP TABLE notification_audit_events; DROP TABLE watch_rule_state; DROP TABLE notification_preferences; DROP TABLE notifications; DELETE FROM schema_version WHERE version = 7;"); raw.close();
    const migrated = new StateStore(path);
    expect(migrated.schemaVersion()).toBe(SCHEMA_VERSION); expect(migrated.loadTasks()).toHaveLength(1); expect(migrated.loadNotificationPreferences()).toEqual(defaultNotificationPreferences);
    migrated.close();
  });

  it("strictly validates filters/preferences and exposes only generic browser payloads", () => {
    expect(() => parseNotificationQuery(new URL("http://localhost/api/notifications?type=arbitrary"))).toThrow("Invalid type");
    expect(() => parseNotificationPreferences({ ...defaultNotificationPreferences, arbitrary: true })).toThrow("exactly");
    const payload = browserNotificationPayload({ type: "finding_high_created" });
    expect(payload).toEqual({ title: "MultiAgents", body: "A high-priority operational item requires review." });
    expect(JSON.stringify(payload)).not.toContain("finding title");
    expect(() => store.createBuiltInNotification({
      type: "arbitrary" as never, severity: "urgent" as never, title: "Injected", message: "Injected", dedupeKey: "arbitrary:key",
    })).toThrow("type or severity");
  });

  it("requires an explicit same-origin human action and blocks agents", () => {
    const url = "http://localhost:3000/api/notifications/read-all";
    const direct = new Request(url, { method: "POST", headers: { host: "localhost:3000" } });
    expect(rejectNonHumanNotificationMutation(direct, "notification-read-all")?.status).toBe(403);
    const human = new Request(url, { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-multiagents-human-action": "notification-read-all" } });
    expect(rejectNonHumanNotificationMutation(human, "notification-read-all")).toBeUndefined();
    const end = beginAgentExecution(); expect(rejectNonHumanNotificationMutation(human, "notification-read-all")?.status).toBe(423); end();
  });
});
