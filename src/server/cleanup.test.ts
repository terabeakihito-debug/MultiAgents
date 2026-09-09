import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCleanupCandidates, executeCleanup, previewCleanup } from "./cleanup";
import { StateStore, replaceStateStoreForTests } from "./state-store";
import { createStateBackup } from "./state-backup";
import { createTask, clearTasksForTests, deleteTask, persistTask, type RepoTask } from "./tasks";
import { acquireTaskLock, releaseTaskLock } from "./task-lock";
import { runGit } from "./git";
import { reconcileUnfinishedOperations } from "./operation-reconciliation";
import { inspectWorktrees } from "./operational-health";
import { requireHumanMutation } from "./request-security";

let store: StateStore;
beforeEach(() => { store = new StateStore(":memory:"); replaceStateStoreForTests(store); });
afterEach(() => replaceStateStoreForTests(new StateStore(":memory:")));

describe("Phase 20C retention candidates", () => {
  it("keeps unread and critical-linked notifications while offering an old read info notification", async () => {
    const old = store.createBuiltInNotification({ type: "task_inactive", severity: "info", title: "Old", message: "Old read notification", dedupeKey: "cleanup-old" })!;
    const unread = store.createBuiltInNotification({ type: "task_inactive", severity: "info", title: "Unread", message: "Unread notification", dedupeKey: "cleanup-unread" })!;
    const critical = store.createBuiltInNotification({ type: "finding_critical_created", severity: "critical", title: "Critical", message: "Critical linkage", dedupeKey: "cleanup-critical" })!;
    store.markNotificationRead(old.notificationId); store.markNotificationRead(critical.notificationId);
    const database = (store as unknown as { database: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).database;
    database.prepare("UPDATE notifications SET read_at = ? WHERE notification_id = ?").run("2020-01-01T00:00:00.000Z", old.notificationId);
    database.prepare("UPDATE notifications SET read_at = ? WHERE notification_id = ?").run("2020-01-01T00:00:00.000Z", critical.notificationId);
    const summary = await evaluateCleanupCandidates({ store, now: new Date("2026-01-01T00:00:00.000Z"), tasks: [] });
    expect(summary.preset).toBe("conservative");
    expect(summary.candidates.find((item) => item.candidateId === `notification:${old.notificationId}`)).toMatchObject({ safeToDelete: true, recommendedAction: "delete" });
    expect(summary.candidates.some((item) => item.candidateId === `notification:${unread.notificationId}`)).toBe(false);
    expect(summary.candidates.find((item) => item.candidateId === `notification:${critical.notificationId}`)?.blockedReasons.join(" ")).toContain("Critical unresolved linkage");
  });

  it("persists the conservative default and permits only fixed presets", () => {
    expect(store.loadRetentionPolicy()).toBe("conservative");
    expect(store.saveRetentionPolicy("balanced")).toBe("balanced");
    expect(store.loadRetentionPolicy()).toBe("balanced");
    expect(() => store.saveRetentionPolicy("custom" as never)).toThrow("Retention preset is invalid");
  });
});

let root: string; let repo: string; let worktrees: string; let backups: string;
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "multiagents-retention-")); repo = join(root, "code", "project"); worktrees = join(root, "worktrees"); backups = join(root, "backups");
  await mkdir(repo, { recursive: true }); await runGit(repo, ["init", "-b", "main"]); await runGit(repo, ["config", "user.email", "test@example.com"]); await runGit(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, ".gitignore"), "node_modules\n"); await writeFile(join(repo, "README.md"), "fixture\n"); await runGit(repo, ["add", "."]); await runGit(repo, ["commit", "-m", "fixture"]);
  store = new StateStore(join(root, "state.db")); replaceStateStoreForTests(store); clearTasksForTests();
  return createTask("project", { allowedRoot: join(root, "code"), worktreeRoot: worktrees, prompt: "fixture" });
}
function archive(task: RepoTask) { task.status = "archived"; persistTask(task); task.updatedAt = "2020-01-01T00:00:00.000Z"; database().prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(task.updatedAt, task.id); }
function candidate(summary: Awaited<ReturnType<typeof evaluateCleanupCandidates>>, id: string) { const value = summary.candidates.find((item) => item.candidateId === id); expect(value).toBeDefined(); return value!; }
function database() { return (store as unknown as { database: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).database; }
async function oldRead() { const item = store.createBuiltInNotification({ type: "task_inactive", severity: "info", title: "old", message: "old notification", dedupeKey: `old-${Math.random()}` })!; store.markNotificationRead(item.notificationId); database().prepare("UPDATE notifications SET read_at = '2020-01-01T00:00:00.000Z' WHERE notification_id = ?").run(item.notificationId); return item; }

describe("Phase 20C negative matrix", () => {
  beforeEach(() => { clearTasksForTests(); });
  afterEach(async () => { clearTasksForTests(); if (root) await rm(root, { recursive: true, force: true }); });
  it("1 dirty worktree is blocked and remains", async () => { const task = await fixture(); archive(task); await writeFile(join(task.worktreePath, "dirty.txt"), "x"); const c = candidate(await evaluateCleanupCandidates(), `worktree:${task.id}`); expect(c.blockedReasons.join(" ")).toContain("Dirty"); await expect(executeCleanup([c.candidateId])).rejects.toThrow(); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("2 running task is blocked and remains", async () => { const task = await fixture(); task.flowStatus = "running"; persistTask(task); const c = candidate(await evaluateCleanupCandidates(), `worktree:${task.id}`); expect(c.safeToDelete).toBe(false); await expect(executeCleanup([c.candidateId])).rejects.toThrow(); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("3 active validation is blocked and remains", async () => { const task = await fixture(); task.status = "validating"; persistTask(task); const c = candidate(await evaluateCleanupCandidates(), `worktree:${task.id}`); expect(c.blockedReasons.join(" ")).toContain("Running task"); await expect(executeCleanup([c.candidateId])).rejects.toThrow(); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("4 open PR is blocked and remains", async () => { const task = await fixture(); archive(task); task.prNumber = 1; task.prReview = { state: "OPEN", merged: false } as RepoTask["prReview"]; const c = candidate(await evaluateCleanupCandidates(), `worktree:${task.id}`); expect(c.blockedReasons.join(" ")).toContain("Open PR"); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("5 ready-for-human-merge is blocked", async () => { const task = await fixture(); task.status = "ready_for_human_merge"; persistTask(task); expect(candidate(await evaluateCleanupCandidates(), `worktree:${task.id}`).blockedReasons.join(" ")).toContain("Ready-for-human-merge"); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("6 symlink worktree is blocked without touching its target", async () => { const task = await fixture(); archive(task); const target = join(root, "outside"); await mkdir(target); await rm(task.worktreePath, { recursive: true }); await symlink(target, task.worktreePath); const c = candidate(await evaluateCleanupCandidates(), `worktree:${task.id}`); expect(c.blockedReasons.join(" ")).toContain("symlink"); await expect(lstat(target)).resolves.toBeDefined(); });
  it("7 arbitrary path IDs are rejected", async () => { const task = await fixture(); const sentinel = join(root, "sentinel"); await writeFile(sentinel, "keep"); await expect(executeCleanup(["worktree:00000000-0000-4000-8000-000000000000"])).rejects.toThrow(); expect(await readFile(sentinel, "utf8")).toBe("keep"); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("8 sibling repository cannot be selected", async () => { const task = await fixture(); archive(task); const sibling = join(root, "sibling"); await mkdir(sibling); task.worktreePath = sibling; persistTask(task); const c = candidate(await evaluateCleanupCandidates(), `worktree:${task.id}`); expect(c.safeToDelete).toBe(false); await expect(executeCleanup([c.candidateId])).rejects.toThrow(); await expect(lstat(sibling)).resolves.toBeDefined(); });
  it("9 regular node_modules is removed while worktree remains", async () => { const task = await fixture(); await mkdir(join(task.worktreePath, "node_modules")); await writeFile(join(task.worktreePath, "node_modules", "x"), "x"); const c = candidate(await evaluateCleanupCandidates(), `worktree_node_modules:${task.id}`); expect(c.safeToDelete).toBe(true); await executeCleanup([c.candidateId]); await expect(lstat(join(task.worktreePath, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" }); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("10 node_modules symlink is blocked without touching target", async () => { const task = await fixture(); const target = join(root, "modules"); await mkdir(target); await symlink(target, join(task.worktreePath, "node_modules")); const c = candidate(await evaluateCleanupCandidates(), `worktree_node_modules:${task.id}`); expect(c.blockedReasons.join(" ")).toContain("symlink"); await expect(lstat(target)).resolves.toBeDefined(); });
  it("11-13 latest three backups are retained and corrupt backup is blocked", async () => { await fixture(); const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004"]; for (let i=0;i<4;i++) await createStateBackup({ store, directory: backups, backupId: ids[i], now: new Date(`2020-01-0${i+1}T00:00:00.000Z`) }); const summary = await evaluateCleanupCandidates({ backupDirectory: backups }); for (const id of ids.slice(1)) expect(candidate(summary, `backup:${id}`).safeToDelete).toBe(false); expect(candidate(summary, `backup:${ids[0]}`).safeToDelete).toBe(true); await writeFile(join(backups, `${ids[0]}.db`), "corrupt"); expect(candidate(await evaluateCleanupCandidates({ backupDirectory: backups }), `backup:${ids[0]}`).safeToDelete).toBe(false); await expect(lstat(join(backups, `${ids[0]}.db`))).resolves.toBeDefined(); });
  it("14-16 unread stays absent; old read and dismissed are candidates", async () => { await fixture(); const read = await oldRead(); const dismissed = store.createBuiltInNotification({ type: "task_inactive", severity: "info", title: "dismissed", message: "dismissed", dedupeKey: "dismissed" })!; store.dismissNotification(dismissed.notificationId); database().prepare("UPDATE notifications SET dismissed_at = '2020-01-01T00:00:00.000Z' WHERE notification_id = ?").run(dismissed.notificationId); const unread = store.createBuiltInNotification({ type: "task_inactive", severity: "info", title: "unread", message: "unread", dedupeKey: "unread" })!; const s = await evaluateCleanupCandidates(); expect(candidate(s, `notification:${read.notificationId}`).safeToDelete).toBe(true); expect(candidate(s, `notification:${dismissed.notificationId}`).safeToDelete).toBe(true); expect(s.candidates.some((x) => x.candidateId === `notification:${unread.notificationId}`)).toBe(false); });
  it("17 security audit remains after notification cleanup", async () => { await fixture(); const item = await oldRead(); store.appendCredentialAudit("credential_status_checked", "github_cli", "configured"); const before = store.loadCredentialAuditEvents().length; await executeCleanup([`notification:${item.notificationId}`]); expect(store.loadCredentialAuditEvents()).toHaveLength(before); expect(store.loadNotification(item.notificationId)).toBeUndefined(); });
  it("18 unresolved finding linkage is retained", async () => { const task = await fixture(); const finding = { findingId: "20000000-0000-4000-8000-000000000001", sourceTaskId: task.id, title: "finding", summary: "finding", severity: "high", status: "open", humanPriority: "normal", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" } as const; store.createFindings([finding]); const item = store.createBuiltInNotification({ type: "finding_high_created", severity: "high", title: "linked", message: "linked", dedupeKey: "linked", findingId: finding.findingId })!; store.markNotificationRead(item.notificationId); database().prepare("UPDATE notifications SET read_at = '2020-01-01T00:00:00.000Z' WHERE notification_id = ?").run(item.notificationId); expect(candidate(await evaluateCleanupCandidates(), `notification:${item.notificationId}`).blockedReasons.join(" ")).toContain("Unresolved finding"); expect(store.loadFinding(finding.findingId)).toBeDefined(); });
  it("19 preview state change rejects execute and retains row", async () => { await fixture(); const item = await oldRead(); await previewCleanup([`notification:${item.notificationId}`]); database().prepare("UPDATE notifications SET status = 'unread' WHERE notification_id = ?").run(item.notificationId); await expect(executeCleanup([`notification:${item.notificationId}`])).rejects.toThrow(); expect(store.loadNotification(item.notificationId)).toBeDefined(); });
  it("20-22 journal, crash reconciliation, and duplicate execution", async () => { const task = await fixture(); await mkdir(join(task.worktreePath, "node_modules")); const id=`worktree_node_modules:${task.id}`; await executeCleanup([id]); expect(store.loadCleanupOperations("cleanup_node_modules", task.id)[0]?.state).toBe("persisted"); await expect(executeCleanup([id])).resolves.toMatchObject({ idempotent: true }); const op=store.createOperation({type:"cleanup_node_modules",taskId:task.id,idempotencyKey:"cleanup:crash"}); store.updateOperation(op.operationId,"executing"); await reconcileUnfinishedOperations(); expect(store.loadOperation(op.operationId)?.state).toBe("reconcile_required"); });
  it("recreates node_modules as a new cleanup generation and adopts an absent crash postcondition", async () => {
    const task = await fixture(); const id = `worktree_node_modules:${task.id}`; const target = join(task.worktreePath, "node_modules");
    await mkdir(target); await writeFile(join(target, "first"), "first");
    await expect(executeCleanup([id])).resolves.toMatchObject({ completed: [id] });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(executeCleanup([id])).resolves.toMatchObject({ completed: [id], idempotent: true });
    const first = store.loadCleanupOperations("cleanup_node_modules", task.id)[0]!;
    await mkdir(target); await writeFile(join(target, "second"), "second");
    await expect(executeCleanup([id])).resolves.toMatchObject({ completed: [id] });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const second = store.loadCleanupOperations("cleanup_node_modules", task.id)[0]!;
    expect(second.operationId).not.toBe(first.operationId);
    const crash = store.createOperation({ type: "cleanup_node_modules", taskId: task.id, idempotencyKey: `cleanup:crash:${task.id}` });
    store.updateOperation(crash.operationId, "executing");
    await expect(executeCleanup([id])).resolves.toMatchObject({ completed: [id], idempotent: true });
    expect(store.loadOperation(crash.operationId)?.state).toBe("persisted");
  });
  it("allows the cleanup owner to remove its own worktree exactly once", async () => { const task = await fixture(); archive(task); await expect(executeCleanup([`worktree:${task.id}`])).resolves.toMatchObject({ completed: [`worktree:${task.id}`] }); await expect(lstat(task.worktreePath)).rejects.toMatchObject({ code: "ENOENT" }); expect(store.loadOperationByKey(`cleanup:worktree:${task.id}`)?.state).toBe("persisted"); });
  it("rejects wrong and released task leases without deleting the worktree", async () => { const task = await fixture(); archive(task); const owner = acquireTaskLock(task.id); const wrong = acquireTaskLock(`${task.id}-other`); expect(owner).toBeTruthy(); expect(wrong).toBeTruthy(); if (!owner || !wrong) throw new Error("fixture lock unavailable"); try { await expect(deleteTask(task.id, { confirmedPrCleanup: true, taskLease: wrong })).rejects.toThrow("not the active owner"); } finally { releaseTaskLock(`${task.id}-other`, wrong); releaseTaskLock(task.id, owner); } await expect(deleteTask(task.id, { confirmedPrCleanup: true, taskLease: owner })).rejects.toThrow("not the active owner"); await expect(lstat(task.worktreePath)).resolves.toBeDefined(); });
  it("permits only one concurrent cleanup owner", async () => { const task = await fixture(); archive(task); const owner = acquireTaskLock(task.id); const loser = acquireTaskLock(task.id); expect(owner).toBeTruthy(); expect(loser).toBe(false); if (owner) releaseTaskLock(task.id, owner); await expect(executeCleanup([`worktree:${task.id}`])).resolves.toMatchObject({ completed: [`worktree:${task.id}`] }); });
  it("23-24 refresh reflects cleanup and evaluation never deletes", async () => { const task = await fixture(); await mkdir(join(task.worktreePath,"node_modules")); await writeFile(join(task.worktreePath,"node_modules","big"),"x".repeat(4000)); const before=(await inspectWorktrees(worktrees)).find(x=>x.taskId===task.id)!.sizeBytes; await evaluateCleanupCandidates(); await expect(lstat(join(task.worktreePath,"node_modules"))).resolves.toBeDefined(); await executeCleanup([`worktree_node_modules:${task.id}`]); const after=(await inspectWorktrees(worktrees)).find(x=>x.taskId===task.id)!.sizeBytes; expect(after).toBeLessThan(before); });
  it("25 missing nonce and 26 wrong origin are rejected without mutation", async () => { await fixture(); const item=await oldRead(); const request=(headers:Record<string,string>)=>new Request("http://127.0.0.1/api/cleanup/execute",{method:"POST",headers:{host:"127.0.0.1:3000","content-type":"application/json",...headers},body:JSON.stringify({candidateIds:[`notification:${item.notificationId}`]})}); expect(requireHumanMutation(request({origin:"http://127.0.0.1:3000","sec-fetch-site":"same-origin","x-multiagents-human-action":"cleanup-execute"}), "cleanup-execute", {label:"Cleanup"})?.status).toBe(403); expect(requireHumanMutation(request({origin:"http://localhost:3000","sec-fetch-site":"same-origin","x-multiagents-human-action":"cleanup-execute","x-multiagents-human-nonce":"bad"}), "cleanup-execute", {label:"Cleanup"})?.status).toBe(403); expect(store.loadNotification(item.notificationId)).toBeDefined(); });
});
