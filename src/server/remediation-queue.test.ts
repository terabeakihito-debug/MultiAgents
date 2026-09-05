import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Finding, HumanPriority } from "../findings/types";
import { changeFindingPriority, markFindingResolved } from "./findings";
import { runGit } from "./git";
import { getRemediationQueue, parseRemediationQueueQuery, RemediationQueueQueryError } from "./remediation-queue";
import { SCHEMA_VERSION, StateStore, replaceStateStoreForTests, type RemediationQueueQuery } from "./state-store";
import { clearTasksForTests, createTask, persistTask, reloadTasksFromStoreForTests, type RepoTask } from "./tasks";

let root: string;
let allowedRoot: string;
let worktreeRoot: string;
let store: StateStore;
let source: RepoTask;
let sequence: number;

const query = (overrides: Partial<RemediationQueueQuery> = {}): RemediationQueueQuery => ({
  pr: "any", converted: "any", sort: "recommended", includeDismissed: false, includeResolved: false,
  limit: 100, offset: 0, ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "multiagents-remediation-"));
  allowedRoot = join(root, "code");
  worktreeRoot = join(root, "worktrees");
  const repoPath = join(allowedRoot, "project");
  await mkdir(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test"]);
  await writeFile(join(repoPath, "README.md"), "initial\n");
  await runGit(repoPath, ["add", "README.md"]);
  await runGit(repoPath, ["commit", "-m", "initial"]);
  await runGit(repoPath, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  store = new StateStore(join(root, "state", "state.db"));
  replaceStateStoreForTests(store);
  clearTasksForTests();
  source = await createTask("project", { allowedRoot, worktreeRoot, templateId: "security_review", prompt: "Review security" });
  sequence = 0;
});

function finding(input: Partial<Finding> = {}) {
  sequence += 1;
  const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  const createdAt = new Date(Date.UTC(2026, 0, sequence)).toISOString();
  const value: Finding = {
    findingId: id, sourceTaskId: source.id, title: `Finding ${sequence}`, summary: "Stored only in detail",
    severity: "medium", category: "security", affectedPaths: [`src/file-${sequence}.ts`], status: "open",
    humanPriority: "normal", createdAt, updatedAt: createdAt, ...input,
  };
  store.createFindings([value]);
  store.appendFindingEvent(value, { type: "finding_created", actor: "system", createdAt });
  return value;
}

async function implementationFor(value: Finding) {
  const task = await createTask("project", { allowedRoot, worktreeRoot, templateId: "bug_fix", prompt: `Fix ${value.title}`, sourceFindingId: value.findingId, sourceTaskId: source.id });
  store.updateFindingStatus(value.findingId, ["open", "accepted"], "converted", task.id);
  return task;
}

function setPriority(id: string, priority: HumanPriority) {
  const raw = new DatabaseSync(store.path);
  raw.prepare("UPDATE findings SET human_priority = ? WHERE finding_id = ?").run(priority, id);
  raw.close();
}

function openReview(number: number, merged = false) {
  return {
    number, title: "Fix", url: `https://github.com/example/project/pull/${number}`,
    state: merged ? "MERGED" : "OPEN", draft: false, merged, base: "main", head: "multiagents/test",
    headSha: "a".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", changedFiles: [], checks: [], items: [],
    reviewCount: 0, unresolvedCount: 0, fetchedAt: "2026-06-01T00:00:00.000Z",
  } as RepoTask["prReview"];
}

describe("Phase 13 remediation queue", () => {
  it("includes open, accepted, and converted while excluding dismissed and resolved by default", async () => {
    const open = finding({ title: "Open" });
    const accepted = finding({ title: "Accepted", status: "accepted" });
    const converted = finding({ title: "Converted", status: "accepted" });
    await implementationFor(converted);
    finding({ title: "Dismissed", status: "dismissed" });
    const resolved = finding({ title: "Resolved", status: "converted" });
    const raw = new DatabaseSync(store.path);
    raw.prepare("UPDATE findings SET resolved_at = ?, resolved_by = 'user' WHERE finding_id = ?").run("2026-07-01T00:00:00.000Z", resolved.findingId);
    raw.close();

    const result = getRemediationQueue(query(), new Date("2026-08-01T00:00:00.000Z"));
    expect(new Set(result.findings.map((item) => item.findingId))).toEqual(new Set([open.findingId, accepted.findingId, converted.findingId]));
    expect(result.findings.find((item) => item.findingId === open.findingId)?.remediationStage).toBe("untriaged");
    expect(result.findings.find((item) => item.findingId === accepted.findingId)?.remediationStage).toBe("implementation_not_created");
    expect(getRemediationQueue(query({ includeDismissed: true, includeResolved: true })).findings).toHaveLength(5);
  });

  it("uses deterministic human priority, severity, stage, age, and ID ranking", () => {
    const oldNormalCritical = finding({ title: "Old critical", severity: "critical", status: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const newAcceptedCritical = finding({ title: "New accepted critical", severity: "critical", status: "accepted", createdAt: "2026-02-01T00:00:00.000Z" });
    const newNormalCritical = finding({ title: "New critical", severity: "critical", status: "open", createdAt: "2026-03-01T00:00:00.000Z" });
    const normalHigh = finding({ title: "Normal high", severity: "high", status: "accepted" });
    const urgentLow = finding({ title: "Urgent low", severity: "low" });
    const highInfo = finding({ title: "High human", severity: "info" });
    setPriority(urgentLow.findingId, "urgent");
    setPriority(highInfo.findingId, "high");
    const first = getRemediationQueue(query()).findings.map((item) => item.findingId);
    const second = getRemediationQueue(query()).findings.map((item) => item.findingId);
    expect(first).toEqual([urgentLow.findingId, highInfo.findingId, oldNormalCritical.findingId, newAcceptedCritical.findingId, newNormalCritical.findingId, normalHigh.findingId]);
    expect(second).toEqual(first);
  });

  it("classifies implementation, approval, PR, merge-ready, and merged stages with server next actions", async () => {
    const activeFinding = finding({ status: "accepted", title: "Active" });
    await implementationFor(activeFinding);
    const approvalFinding = finding({ status: "accepted", title: "Approval" });
    const approval = await implementationFor(approvalFinding); approval.status = "awaiting_approval"; persistTask(approval);
    const prFinding = finding({ status: "accepted", title: "PR" });
    const pr = await implementationFor(prFinding); pr.status = "pr_created"; pr.prNumber = 11; pr.prUrl = "https://github.com/example/project/pull/11"; pr.prReview = openReview(11); persistTask(pr);
    const readyFinding = finding({ status: "accepted", title: "Ready" });
    const ready = await implementationFor(readyFinding); ready.status = "ready_for_human_merge"; ready.prNumber = 12; ready.prUrl = "https://github.com/example/project/pull/12"; ready.prReview = openReview(12); persistTask(ready);
    const mergedFinding = finding({ status: "accepted", title: "Merged" });
    const merged = await implementationFor(mergedFinding); merged.status = "ready_for_human_merge"; merged.prNumber = 13; merged.prUrl = "https://github.com/example/project/pull/13"; merged.prReview = openReview(13, true); persistTask(merged);
    const rows = getRemediationQueue(query()).findings;
    const item = (id: string) => rows.find((row) => row.findingId === id);
    expect(item(activeFinding.findingId)).toMatchObject({ remediationStage: "implementation_active", nextAction: "resume_implementation" });
    expect(item(approvalFinding.findingId)).toMatchObject({ remediationStage: "awaiting_approval", nextAction: "review_diff" });
    expect(item(prFinding.findingId)).toMatchObject({ remediationStage: "pr_open", nextAction: "fetch_pr_review", prNumber: 11 });
    expect(item(readyFinding.findingId)).toMatchObject({ remediationStage: "ready_for_human_merge", nextAction: "human_merge" });
    expect(item(mergedFinding.findingId)).toMatchObject({ remediationStage: "resolved_candidate", nextAction: "mark_resolved" });
  });

  it("supports repository, severity, priority, stage, PR, conversion, search, counts, sorts, limits, and offsets", async () => {
    const critical = finding({ title: "Unsafe validator", severity: "critical", category: "validation", affectedPaths: ["src/server/check.ts"] });
    const high = finding({ title: "Authentication bypass", severity: "high", status: "accepted" });
    setPriority(high.findingId, "urgent");
    const linked = await implementationFor(high); linked.status = "pr_created"; linked.prNumber = 42; linked.prUrl = "https://github.com/example/project/pull/42"; linked.prReview = openReview(42); persistTask(linked);
    expect(getRemediationQueue(query()).counts).toMatchObject({ total: 2, critical: 1, high: 1 });
    expect(getRemediationQueue(query({ repo: "project" })).findings).toHaveLength(2);
    expect(getRemediationQueue(query({ severity: "critical" })).findings.map((item) => item.findingId)).toEqual([critical.findingId]);
    expect(getRemediationQueue(query({ status: "converted" })).findings.map((item) => item.findingId)).toEqual([high.findingId]);
    expect(getRemediationQueue(query({ priority: "urgent" })).findings.map((item) => item.findingId)).toEqual([high.findingId]);
    expect(getRemediationQueue(query({ stage: "pr_open" })).findings.map((item) => item.findingId)).toEqual([high.findingId]);
    expect(getRemediationQueue(query({ pr: "yes" })).findings).toHaveLength(1);
    expect(getRemediationQueue(query({ converted: "no" })).findings).toHaveLength(1);
    for (const search of ["validator", "validation", "server/check", "#42"]) expect(getRemediationQueue(query({ search })).findings).toHaveLength(1);
    expect(getRemediationQueue(query({ search: "project" })).findings).toHaveLength(2);
    expect(getRemediationQueue(query({ sort: "severity" })).findings[0].findingId).toBe(critical.findingId);
    expect(getRemediationQueue(query({ sort: "repo", limit: 1, offset: 1 })).findings).toHaveLength(1);
  });

  it("detects a missing linked task as Needs Attention", () => {
    const orphan = finding({ status: "converted", title: "Orphan converted" });
    const raw = new DatabaseSync(store.path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("UPDATE findings SET converted_task_id = ? WHERE finding_id = ?").run("99999999-9999-4999-8999-999999999999", orphan.findingId);
    raw.close();
    expect(getRemediationQueue(query()).findings[0]).toMatchObject({ remediationStage: "needs_attention", nextAction: "manual_recovery", attentionReason: "The converted implementation task is missing." });
  });

  it("persists human priority with audit and enforces the human merged-PR resolution gate", async () => {
    const value = finding({ status: "accepted" });
    expect(() => changeFindingPriority(value.findingId, "invalid" as HumanPriority)).toThrow("invalid");
    expect(changeFindingPriority(value.findingId, "high").humanPriority).toBe("high");
    expect(store.loadFindingEvents(value.findingId).at(-1)).toMatchObject({ type: "finding_priority_changed", actor: "user", previousHumanPriority: "normal", humanPriority: "high" });
    const task = await implementationFor(value);
    task.prNumber = 22; task.prUrl = "https://github.com/example/project/pull/22"; task.prReview = openReview(22); persistTask(task);
    expect(() => markFindingResolved(value.findingId)).toThrow("confirmed merged");
    task.prReview = openReview(22, true); persistTask(task);
    expect(markFindingResolved(value.findingId)).toMatchObject({ resolvedBy: "user" });
    expect(store.loadFindingEvents(value.findingId).at(-1)).toMatchObject({ type: "finding_resolved", actor: "user" });
    reloadTasksFromStoreForTests();
    expect(store.loadFinding(value.findingId)).toMatchObject({ humanPriority: "high", resolvedBy: "user" });
    expect(getRemediationQueue(query()).findings).toHaveLength(0);
    expect(getRemediationQueue(query({ includeResolved: true })).findings[0].remediationStage).toBe("resolved");
  });

  it("strictly validates queue query values and bounds", () => {
    expect(parseRemediationQueueQuery(new URL("http://localhost/api/findings/queue?sort=recommended&limit=100&offset=2"))).toMatchObject({ sort: "recommended", limit: 100, offset: 2 });
    for (const suffix of ["priority=auto", "severity=urgent", "stage=made_up", "pr=true", "converted=true", "includeResolved=1", "limit=101", "offset=-1"]) {
      expect(() => parseRemediationQueueQuery(new URL(`http://localhost/api/findings/queue?${suffix}`))).toThrow(RemediationQueueQueryError);
    }
  });
});

describe("Phase 13 v5 to v6 migration", () => {
  it("defaults existing findings to normal priority and preserves history", () => {
    const path = join(root, "v5.db");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES (5, '2026-01-01T00:00:00.000Z');
      CREATE TABLE tasks (task_id TEXT PRIMARY KEY);
      INSERT INTO tasks VALUES ('11111111-1111-4111-8111-111111111111');
      CREATE TABLE findings (
        finding_id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL REFERENCES tasks(task_id), title TEXT NOT NULL,
        summary TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
        category TEXT, affected_paths_json TEXT, evidence TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','accepted','dismissed','converted')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, converted_task_id TEXT UNIQUE REFERENCES tasks(task_id)
      );
      INSERT INTO findings VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Old','Kept','high',NULL,NULL,NULL,'accepted','2026-01-01','2026-01-01',NULL);
      CREATE TABLE finding_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        finding_id TEXT NOT NULL REFERENCES findings(finding_id), source_task_id TEXT NOT NULL REFERENCES tasks(task_id),
        event_type TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT, converted_task_id TEXT REFERENCES tasks(task_id)
      );
      INSERT INTO finding_events(event_id,finding_id,source_task_id,event_type,actor,created_at) VALUES ('event','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','finding_created','system','2026-01-01');
      CREATE TABLE task_events (id INTEGER); CREATE TABLE step_versions (id INTEGER); CREATE TABLE diff_versions (id INTEGER);
      CREATE TABLE approval_events (id INTEGER); CREATE TABLE project_profile_versions (id INTEGER); CREATE TABLE profile_audit_events (id INTEGER);
      CREATE TABLE task_template_versions (id INTEGER); CREATE TABLE template_audit_events (id INTEGER);
    `);
    database.close();
    const migrated = new StateStore(path);
    expect(migrated.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(migrated.loadFinding("22222222-2222-4222-8222-222222222222")).toMatchObject({ humanPriority: "normal", title: "Old" });
    expect(migrated.loadFindingEvents("22222222-2222-4222-8222-222222222222")).toMatchObject([{ type: "finding_created" }]);
    const raw = new DatabaseSync(path);
    expect(() => raw.prepare("UPDATE finding_events SET actor = 'user'").run()).toThrow("append-only");
    raw.close(); migrated.close();
  });
});
