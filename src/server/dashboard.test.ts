import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PullRequestReview } from "./pr-review-types";
import { DashboardQueryError, getDashboard, nextActionFor, parseDashboardQuery, summarizeTaskPrompt, validatedDashboardPrUrl } from "./dashboard";
import { StateStore, replaceStateStoreForTests, type DashboardQuery } from "./state-store";
import type { RepoTask, TaskStatus } from "./tasks";

let store: StateStore;

const query = (overrides: Partial<DashboardQuery> = {}): DashboardQuery => ({
  pr: "any", sort: "updated_desc", includeArchived: false, limit: 100, ...overrides,
});

function review(overrides: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    number: 1, title: "PR", url: "https://github.com/example/repo/pull/1", state: "OPEN", draft: false, merged: false,
    base: "main", head: "multiagents/11111111-1111-4111-8111-111111111111", headSha: "a".repeat(40),
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", changedFiles: [], checks: [], items: [], reviewCount: 0, unresolvedCount: 0,
    fetchedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

function task(id: string, status: TaskStatus, overrides: Partial<RepoTask> = {}): RepoTask {
  return {
    id, repoId: overrides.repoId ?? "repo", repoName: overrides.repoName ?? "Repo", repoPath: "/allowed/repo", allowedRoot: "/allowed",
    branch: `multiagents/${id}`, baseBranch: "main", baseSha: "b".repeat(40), worktreePath: `/worktrees/repo/${id}`,
    worktreeRoot: "/worktrees", worktreeAvailable: true, worktreeStatus: "available", status, prompt: "Fix retry state",
    reviewReady: false, approvalState: "unavailable", validation: [], secretFindings: [], originalTaskAvailable: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", recoveryStatus: "recoverable",
    ...overrides,
  };
}

beforeEach(() => {
  store = new StateStore(":memory:");
  replaceStateStoreForTests(store);
});

afterEach(() => { replaceStateStoreForTests(new StateStore(":memory:")); });

describe("Phase 9 dashboard query", () => {
  it("displays the immutable task profile name and version", async () => {
    const item = task("10111111-1111-4111-8111-111111111111", "draft", { worktreeAvailable: false, worktreeStatus: "missing" });
    store.saveTask(item);
    const result = await getDashboard(query(), new Date("2026-01-01T00:00:01.000Z"));
    expect(result.tasks[0]).toMatchObject({ profileName: "safe_default", profileVersion: 1 });
  });

  it("classifies every dashboard bucket and returns counts", () => {
    store.saveTask(task("11111111-1111-4111-8111-111111111111", "draft", { flowStatus: "running" }));
    store.saveTask(task("22222222-2222-4222-8222-222222222222", "ci_failed"));
    store.saveTask(task("33333333-3333-4333-8333-333333333333", "awaiting_approval"));
    store.saveTask(task("44444444-4444-4444-8444-444444444444", "pr_created", { prNumber: 1, prUrl: "https://github.com/example/repo/pull/1", prReview: review({ head: "multiagents/44444444-4444-4444-8444-444444444444" }) }));
    store.saveTask(task("55555555-5555-4555-8555-555555555555", "ready_for_human_merge", {
      prNumber: 2, prUrl: "https://github.com/example/repo/pull/2", validation: [{ name: "validation", status: "pass" }, { name: "optional", status: "skip" }],
      prReview: review({ number: 2, url: "https://github.com/example/repo/pull/2", head: "multiagents/55555555-5555-4555-8555-555555555555", checks: [{ name: "required", state: "SUCCESS", bucket: "pass", required: true }] }),
      reviewIntake: { status: "completed", steps: [], requiresRework: false, readyForHumanMerge: true },
    }));
    store.saveTask(task("66666666-6666-4666-8666-666666666666", "archived", { worktreeAvailable: false, worktreeStatus: "removed" }));

    const result = store.queryDashboard(query({ includeArchived: true }));
    expect(Object.fromEntries(result.rows.map((row) => [row.taskId, row.bucket]))).toEqual({
      "11111111-1111-4111-8111-111111111111": "active",
      "22222222-2222-4222-8222-222222222222": "needs_attention",
      "33333333-3333-4333-8333-333333333333": "ready_for_approval",
      "44444444-4444-4444-8444-444444444444": "pr_open",
      "55555555-5555-4555-8555-555555555555": "ready_for_human_merge",
      "66666666-6666-4666-8666-666666666666": "archived",
    });
    expect(result.counts).toEqual({ active: 1, needs_attention: 1, ready_for_approval: 1, pr_open: 1, ready_for_human_merge: 1, archived: 1 });
  });

  it("requires all strict readiness signals and never treats an open PR alone as ready", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    store.saveTask(task(id, "ready_for_human_merge", { prNumber: 1, prUrl: "https://github.com/example/repo/pull/1", validation: [{ name: "validation", status: "pass" }], prReview: review({ head: `multiagents/${id}`, items: [{ id: "x", kind: "check", author: "GitHub", body: "", disposition: "blocking", reason: "failed" }] }) }));
    expect(store.queryDashboard(query()).rows[0].bucket).toBe("pr_open");
  });

  it("filters in SQLite by repository, status, PR presence, bucket, and text", () => {
    const first = task("11111111-1111-4111-8111-111111111111", "draft", { repoId: "alpha", repoName: "Alpha", prompt: "Fix quiz retry" });
    const second = task("22222222-2222-4222-8222-222222222222", "awaiting_approval", { repoId: "beta", repoName: "Beta", prompt: "Improve dashboard", prNumber: 42, prUrl: "https://github.com/example/repo/pull/42" });
    store.saveTask(first); store.saveTask(second);
    expect(store.queryDashboard(query({ repo: "alpha" })).rows.map((row) => row.taskId)).toEqual([first.id]);
    expect(store.queryDashboard(query({ status: "awaiting_approval" })).rows.map((row) => row.taskId)).toEqual([second.id]);
    expect(store.queryDashboard(query({ pr: "with_pr" })).rows.map((row) => row.taskId)).toEqual([second.id]);
    expect(store.queryDashboard(query({ bucket: "ready_for_approval" })).rows.map((row) => row.taskId)).toEqual([second.id]);
    expect(store.queryDashboard(query({ search: "QUIZ" })).rows.map((row) => row.taskId)).toEqual([first.id]);
    expect(store.queryDashboard(query({ search: "#42" })).rows.map((row) => row.taskId)).toEqual([second.id]);
    expect(store.queryDashboard(query({ search: "42" })).rows.map((row) => row.taskId)).toEqual([second.id]);
  });

  it("hides archived tasks by default, includes them explicitly, limits rows, and orders by repository", () => {
    const archived = task("11111111-1111-4111-8111-111111111111", "archived", { repoName: "Zulu", worktreeAvailable: false, worktreeStatus: "removed" });
    const active = task("22222222-2222-4222-8222-222222222222", "draft", { repoName: "Alpha" });
    store.saveTask(archived); store.saveTask(active);
    expect(store.queryDashboard(query()).rows.map((row) => row.taskId)).toEqual([active.id]);
    expect(store.queryDashboard(query({ includeArchived: true, sort: "repo_name", limit: 1 })).rows.map((row) => row.repoName)).toEqual(["Alpha"]);
    expect(store.queryDashboard(query({ bucket: "archived" })).rows.map((row) => row.taskId)).toEqual([archived.id]);
  });

  it("uses updated-desc ordering by default", async () => {
    const older = task("11111111-1111-4111-8111-111111111111", "draft");
    const newer = task("22222222-2222-4222-8222-222222222222", "draft");
    store.saveTask(older);
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.saveTask(newer);
    expect(store.queryDashboard(query()).rows.map((row) => row.taskId)).toEqual([newer.id, older.id]);
  });

  it("validates dashboard query values and limit", () => {
    expect(parseDashboardQuery(new URL("http://localhost/api/dashboard/tasks?limit=100&sort=created_desc&includeArchived=true"))).toMatchObject({ limit: 100, sort: "created_desc", includeArchived: true });
    expect(() => parseDashboardQuery(new URL("http://localhost/api/dashboard/tasks?limit=101"))).toThrow(DashboardQueryError);
    expect(() => parseDashboardQuery(new URL("http://localhost/api/dashboard/tasks?bucket=made_up"))).toThrow("Invalid bucket");
    expect(() => parseDashboardQuery(new URL("http://localhost/api/dashboard/tasks?sort=random"))).toThrow("Invalid sort");
  });

  it("creates a single-line, bounded, credential-redacted summary", () => {
    const summary = summarizeTaskPrompt(`Fix login\npassword=hunter2 ${"x".repeat(180)}`);
    expect(summary).not.toContain("hunter2");
    expect(summary).not.toContain("\n");
    expect(Array.from(summary).length).toBeLessThanOrEqual(120);
  });

  it("maps deterministic next actions without agent input", () => {
    expect(nextActionFor({ bucket: "needs_attention", status: "approval_invalidated", worktreeStatus: "available" })).toBe("revalidate");
    expect(nextActionFor({ bucket: "needs_attention", status: "draft", worktreeStatus: "missing" })).toBe("manual_recovery");
    expect(nextActionFor({ bucket: "ready_for_approval", status: "awaiting_final_approval", worktreeStatus: "available" })).toBe("review_rework_diff");
    expect(nextActionFor({ bucket: "ready_for_human_merge", status: "ready_for_human_merge", worktreeStatus: "available", prNumber: 1 })).toBe("human_merge");
  });

  it("emits only a PR URL that matches the validated GitHub origin and number", () => {
    const value = task("11111111-1111-4111-8111-111111111111", "pr_created", { originUrl: "git@github.com:example/repo.git" });
    expect(validatedDashboardPrUrl(value, { prNumber: 7, prUrl: "https://github.com/example/repo/pull/7" })).toBe("https://github.com/example/repo/pull/7");
    expect(validatedDashboardPrUrl(value, { prNumber: 7, prUrl: "https://evil.example/pr/7" })).toBeUndefined();
  });
});
