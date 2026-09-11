import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_STATE_COMPAT, StateStore, replaceStateStoreForTests } from "./state-store";
import { clearTasksForTests, createTask, getTask, persistTask, reloadTasksFromStoreForTests, resumeTask } from "./tasks";
import { runGit, setGitTransportRootForTests } from "./git";
import { reconcileUnfinishedOperations } from "./operation-reconciliation";
import { createStateBackup, validateBackupFile, validateStateBackup } from "./state-backup";
import { diagnoseProvider } from "./provider-diagnostics";
import { assertWorktreeDiskCapacity, backupStatus, inspectTaskWorktrees, inspectWorktrees, MINIMUM_WORKTREE_FREE_BYTES } from "./operational-health";
import { beginRegisteredOperation, drainOperations, lifecycleState } from "./operation-registry";

let fixtureRoot: string;
let allowedRoot: string;
let repoPath: string;
let worktreeRoot: string;
let remotePath: string;
let store: StateStore;
const execFile = promisify(execFileCallback);

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "multiagents-phase19-"));
  allowedRoot = join(fixtureRoot, "code");
  repoPath = join(allowedRoot, "project");
  worktreeRoot = join(fixtureRoot, "worktrees");
  remotePath = join(fixtureRoot, "origin.git");
  await mkdir(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test"]);
  await writeFile(join(repoPath, "README.md"), "initial\n");
  await runGit(repoPath, ["add", "README.md"]);
  await runGit(repoPath, ["commit", "-m", "initial"]);
  await runGit(fixtureRoot, ["init", "--bare", remotePath]);
  await runGit(repoPath, ["remote", "add", "origin", remotePath]);
  setGitTransportRootForTests(join(fixtureRoot, "transport-runtime", "git-transport"));
  store = new StateStore(join(fixtureRoot, "state", "state.db"));
  replaceStateStoreForTests(store);
  clearTasksForTests();
});

afterEach(() => {
  setGitTransportRootForTests();
  replaceStateStoreForTests(new StateStore(":memory:"));
  clearTasksForTests();
});

async function taskFixture() {
  return createTask("project", { allowedRoot, worktreeRoot, prompt: "Phase 19 fixture" });
}

describe("Phase 19 base drift recovery", () => {
  it("keeps an unchanged managed task recoverable when main advances", async () => {
    const task = await taskFixture();
    await writeFile(join(repoPath, "CHANGELOG.md"), "next\n");
    await runGit(repoPath, ["add", "CHANGELOG.md"]);
    await runGit(repoPath, ["commit", "-m", "advance main"]);

    reloadTasksFromStoreForTests();
    const recovered = await resumeTask(task.id, { allowedRoot, worktreeRoot });
    expect(recovered).toMatchObject({ recoveryStatus: "recoverable", worktreeStatus: "available", baseState: "base_advanced", baseAheadCount: 1 });
    expect(recovered?.recoveryMessage).toBe("Base advanced by 1 commit.");
  });

  it("classifies unrelated replacement history as base_diverged without rebasing", async () => {
    const task = await taskFixture();
    await runGit(repoPath, ["checkout", "--orphan", "replacement"]);
    await runGit(repoPath, ["rm", "-rf", "."]);
    await writeFile(join(repoPath, "replacement.txt"), "unrelated\n");
    await runGit(repoPath, ["add", "replacement.txt"]);
    await runGit(repoPath, ["commit", "-m", "replace history"]);
    await runGit(repoPath, ["branch", "-M", "main"]);

    reloadTasksFromStoreForTests();
    const recovered = await resumeTask(task.id, { allowedRoot, worktreeRoot });
    expect(recovered).toMatchObject({ recoveryStatus: "needs_attention", worktreeStatus: "available", baseState: "base_diverged" });
    expect(await runGit(task.worktreePath, ["rev-parse", "HEAD"])).toBe(task.baseSha);
  });

  it("rejects a missing original base object and a task branch mismatch", async () => {
    const missing = await taskFixture();
    missing.baseSha = "f".repeat(40);
    persistTask(missing);
    reloadTasksFromStoreForTests();
    await expect(resumeTask(missing.id, { allowedRoot, worktreeRoot })).rejects.toThrow("Original task base commit is missing");
    expect(getTask(missing.id)).toMatchObject({ recoveryStatus: "invalid", baseState: "base_missing" });

    clearTasksForTests();
    const second = await taskFixture();
    await runGit(second.worktreePath, ["switch", "-c", "wrong-branch"]);
    reloadTasksFromStoreForTests();
    await expect(resumeTask(second.id, { allowedRoot, worktreeRoot })).rejects.toThrow("Task branch does not match");
  });
});

describe("Phase 19 durable journal reconciliation", () => {
  it("deduplicates logical operations and rejects unsafe metadata", () => {
    const key = `worktree_create:${crypto.randomUUID()}`;
    const first = store.createOperation({ type: "worktree_create", idempotencyKey: key, safeMetadata: { branch: "safe" } });
    const second = store.createOperation({ type: "worktree_create", idempotencyKey: key, safeMetadata: { branch: "safe" } });
    expect(second.operationId).toBe(first.operationId);
    expect(() => store.createOperation({ type: "git_push", idempotencyKey: key })).toThrow("conflicts");
    expect(() => store.createOperation({ type: "git_push", idempotencyKey: `git_push:${crypto.randomUUID()}`, safeMetadata: { token: "not-persisted" } })).toThrow("forbidden");
  });

  it("adopts a worktree created before task state persistence", async () => {
    const task = await taskFixture();
    const operation = store.loadOperationByKey(`worktree_create:${task.id}`)!;
    task.worktreeAvailable = false; task.worktreeStatus = "missing"; persistTask(task);
    store.updateOperation(operation.operationId, "executing");

    await reconcileUnfinishedOperations();
    expect(getTask(task.id)).toMatchObject({ worktreeAvailable: true, worktreeStatus: "available" });
    expect(store.loadOperation(operation.operationId)?.state).toBe("persisted");
  });

  it("adopts a verified commit after the commit/DB crash window", async () => {
    const task = await taskFixture();
    await writeFile(join(task.worktreePath, "change.txt"), "committed\n");
    await runGit(task.worktreePath, ["add", "change.txt"]);
    const expectedParent = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
    const expectedTree = await runGit(task.worktreePath, ["write-tree"]);
    const operation = store.createOperation({ type: "git_commit", taskId: task.id, idempotencyKey: `git_commit:${task.id}:fixture`, safeMetadata: { expectedParent, expectedTree, approvalId: crypto.randomUUID() } });
    store.updateOperation(operation.operationId, "executing");
    await runGit(task.worktreePath, ["commit", "-m", "fixture commit"]);

    await reconcileUnfinishedOperations();
    const head = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
    expect(getTask(task.id)).toMatchObject({ commitSha: head, status: "push_failed", recoveryStatus: "needs_attention" });
    expect(store.loadOperation(operation.operationId)?.state).toBe("persisted");
  });

  it("does not reconcile a push through an unvalidated local remote", async () => {
    const task = await taskFixture();
    await writeFile(join(task.worktreePath, "pushed.txt"), "pushed\n");
    await runGit(task.worktreePath, ["add", "pushed.txt"]);
    await runGit(task.worktreePath, ["commit", "-m", "push fixture"]);
    const head = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
    task.commitSha = head; task.status = "pushing"; persistTask(task);
    const operation = store.createOperation({ type: "git_push", taskId: task.id, idempotencyKey: `git_push:${task.id}:${head}`, safeMetadata: { branch: task.branch, expectedSha: head } });
    store.updateOperation(operation.operationId, "executing");
    await runGit(task.worktreePath, ["push", "origin", `HEAD:refs/heads/${task.branch}`]);

    await reconcileUnfinishedOperations();
    expect(getTask(task.id)).toMatchObject({ status: "pushing" });
    expect(getTask(task.id)?.latestPushedSha).toBeUndefined();
    expect(store.loadOperation(operation.operationId)?.state).toBe("reconcile_required");
  });

  it("rejects uploadpack before push reconciliation can execute it", async () => {
    const task = await taskFixture();
    const marker = join(fixtureRoot, "uploadpack-marker"); const script = join(fixtureRoot, "uploadpack");
    await writeFile(script, `#!/bin/sh\nprintf executed > ${marker}\n`); await chmod(script, 0o700);
    await runGit(task.worktreePath, ["config", "remote.origin.uploadpack", script]);
    const operation = store.createOperation({ type: "git_push", taskId: task.id, idempotencyKey: `git_push:${task.id}:uploadpack`, safeMetadata: { branch: task.branch, expectedSha: task.baseSha } });
    store.updateOperation(operation.operationId, "executing");
    await reconcileUnfinishedOperations();
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.loadOperation(operation.operationId)?.state).toBe("reconcile_required");
  });

  it("adopts exactly one matching PR and never creates a duplicate", async () => {
    const task = await taskFixture();
    const expectedSha = task.baseSha;
    const operation = store.createOperation({ type: "pr_create", taskId: task.id, idempotencyKey: `pr_create:${task.id}:${expectedSha}`, safeMetadata: { expectedSha, branch: task.branch, baseBranch: task.baseBranch } });
    store.updateOperation(operation.operationId, "executing");
    const finder = vi.fn(async () => [{ number: 42, url: "https://github.com/example/project/pull/42", headRefOid: expectedSha, headRefName: task.branch, baseRefName: task.baseBranch }]);

    await reconcileUnfinishedOperations({ findPullRequests: finder });
    expect(finder).toHaveBeenCalledOnce();
    expect(getTask(task.id)).toMatchObject({ prNumber: 42, status: "pr_created" });
    expect(store.loadOperation(operation.operationId)?.state).toBe("persisted");
    await reconcileUnfinishedOperations({ findPullRequests: finder });
    expect(finder).toHaveBeenCalledOnce();
  });
});

describe("Phase 19 backup, compatibility, diagnostics, disk and drain", () => {
  it("classifies fresh, aging, stale, and missing backups deterministically", () => {
    expect(backupStatus(0)).toBe("ok");
    expect(backupStatus(23.99)).toBe("ok");
    expect(backupStatus(24)).toBe("warning");
    expect(backupStatus(72)).toBe("warning");
    expect(backupStatus(72.01)).toBe("attention");
    expect(backupStatus(null)).toBe("attention");
  });

  it("creates and verifies a private native SQLite backup with metadata", async () => {
    await taskFixture();
    const directory = join(fixtureRoot, "backups");
    const backup = await createStateBackup({ store, directory });
    expect(backup).toMatchObject({ schemaVersion: APP_STATE_COMPAT.maxSchema, integrityStatus: "ok" });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, `${backup.backupId}.db`))).mode & 0o777).toBe(0o600);
    expect(validateStateBackup(backup.backupId, { store, directory })).toMatchObject({ verified: true });
    expect(validateBackupFile(join(directory, `${backup.backupId}.db`))).toMatchObject({ integrity: "ok", schemaVersion: APP_STATE_COMPAT.maxSchema });
  });

  it("accepts a v9 migration source and applies every migration through v13", async () => {
    const path = join(fixtureRoot, "v9-source.db");
    const current = new StateStore(path); current.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE provider_compatibility_acknowledgements; DROP TABLE provider_compatibility_snapshots; DROP TABLE cleanup_audit_events; DROP TABLE retention_policy; DROP TABLE backup_metadata; DELETE FROM schema_version WHERE version > 9;");
    raw.close();
    expect(validateBackupFile(path)).toMatchObject({ schemaVersion: 9, compatibility: "valid_migratable" });
    const migrated = new StateStore(path);
    expect(migrated.schemaVersion()).toBe(APP_STATE_COMPAT.maxSchema);
    expect(migrated.integrityCheck()).toBe("ok");
    migrated.close();
  });

  it("restores a verified backup only while the server is offline", async () => {
    const restoreHome = join(fixtureRoot, "restore-home");
    const restoreStateDirectory = join(restoreHome, ".multiagents");
    const restorePath = join(restoreStateDirectory, "state.db");
    await mkdir(restoreStateDirectory, { recursive: true, mode: 0o700 });
    const restoreStore = new StateStore(restorePath);
    const saved = restoreStore.createBuiltInNotification({
      type: "ci_failed", severity: "high", title: "Saved", message: "Restored fixture notification", dedupeKey: `restore:${crypto.randomUUID()}`,
    })!;
    const backup = await createStateBackup({ store: restoreStore, directory: join(restoreStateDirectory, "backups") });
    restoreStore.createBuiltInNotification({
      type: "task_needs_attention", severity: "warning", title: "Later", message: "This must be removed by restore", dedupeKey: `later:${crypto.randomUUID()}`,
    });
    restoreStore.close();

    await expect(execFile(process.execPath, ["scripts/state-restore.mjs", backup.backupId], {
      cwd: process.cwd(), env: { ...process.env, HOME: restoreHome },
    })).resolves.toBeDefined();
    const restored = new StateStore(restorePath);
    expect(restored.loadNotification(saved.notificationId)).toMatchObject({ title: "Saved" });
    expect(restored.queryNotifications({ limit: 100, unreadOnly: false }).notifications.map((item) => item.title)).not.toContain("Later");
    restored.close();
  });

  it("rejects corrupt, unsupported-schema, database-symlink and parent-symlink state", async () => {
    const directory = join(fixtureRoot, "backups");
    const backup = await createStateBackup({ store, directory });
    const corrupt = join(fixtureRoot, "corrupt.db");
    await writeFile(corrupt, "not sqlite", { mode: 0o600 });
    expect(() => validateBackupFile(corrupt)).toThrow();

    const newer = join(fixtureRoot, "newer.db");
    await copyFile(join(directory, `${backup.backupId}.db`), newer);
    await chmod(newer, 0o600);
    const raw = new DatabaseSync(newer); raw.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(99, new Date().toISOString()); raw.close();
    expect(() => validateBackupFile(newer)).toThrow("schema is newer than supported");

    const newerState = join(fixtureRoot, "newer-state.db");
    const newerStore = new StateStore(newerState); newerStore.close();
    const newerStateRaw = new DatabaseSync(newerState); newerStateRaw.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(99, new Date().toISOString()); newerStateRaw.close();
    expect(() => new StateStore(newerState)).toThrow("newer than supported");

    const target = join(fixtureRoot, "target.db"); await writeFile(target, "x");
    const linkedDb = join(fixtureRoot, "linked.db"); await symlink(target, linkedDb);
    expect(() => new StateStore(linkedDb)).toThrow("cannot be a symlink");
    const realParent = join(fixtureRoot, "real-parent"); await mkdir(realParent);
    const linkedParent = join(fixtureRoot, "linked-parent"); await symlink(realParent, linkedParent);
    expect(() => new StateStore(join(linkedParent, "state.db"))).toThrow("cannot be a symlink");
  });

  it("reports provider compatibility without reading credential contents", async () => {
    const help = "--ignore-user-config --ignore-rules --ephemeral --sandbox --dangerously-bypass-approvals-and-sandbox --cd";
    const execute = vi.fn(async (args: string[]) => args[0] === "--version" ? { code: 0, stdout: "codex-cli 0.153.4", stderr: "" } : { code: 0, stdout: help, stderr: "" });
    await expect(diagnoseProvider("codex", { executableAvailable: true, credentialAvailable: true, execute })).resolves.toMatchObject({ status: "supported", version: "0.153.4" });
    await expect(diagnoseProvider("codex", { executableAvailable: true, credentialAvailable: true, execute: async () => ({ code: 0, stdout: "codex-cli 0.1.0", stderr: "" }) })).resolves.toMatchObject({ status: "unsupported_version" });
    await expect(diagnoseProvider("codex", { executableAvailable: false, credentialAvailable: true })).resolves.toMatchObject({ status: "missing" });
    await expect(diagnoseProvider("codex", { executableAvailable: true, credentialAvailable: false })).resolves.toMatchObject({ status: "credential_unavailable" });
    await expect(diagnoseProvider("codex", { executableAvailable: true, credentialAvailable: true, execute: async () => { throw new Error("namespace failed"); } })).resolves.toMatchObject({ status: "version_probe_failed" });
  });

  it("blocks only new worktree creation below the disk threshold", async () => {
    await expect(assertWorktreeDiskCapacity({ freeBytes: MINIMUM_WORKTREE_FREE_BYTES - 1 })).rejects.toThrow("insufficient_disk_space");
    expect(store.loadTasks()).toEqual([]);
  });

  it("classifies registered, missing, orphaned, and unregistered Git worktrees", async () => {
    const task = await taskFixture();
    expect((await inspectTaskWorktrees([task]))[0]).toMatchObject({ inventoryStatus: "registered", dirty: false });
    await rename(task.worktreePath, `${task.worktreePath}-missing`);
    expect((await inspectTaskWorktrees([task]))[0]).toMatchObject({ inventoryStatus: "missing_filesystem" });
    await rename(`${task.worktreePath}-missing`, task.worktreePath);

    const orphan = join(worktreeRoot, "project", crypto.randomUUID());
    await runGit(repoPath, ["worktree", "add", "--detach", orphan, "HEAD"]);
    const inventory = await inspectWorktrees(worktreeRoot);
    expect(inventory.some((item) => item.inventoryStatus === "unregistered_git_worktree" && item.repoId === "project")).toBe(true);
    const plain = join(worktreeRoot, "project", crypto.randomUUID()); await mkdir(plain); await writeFile(join(plain, "x"), "x");
    expect((await inspectWorktrees(worktreeRoot)).some((item) => item.inventoryStatus === "orphaned_filesystem")).toBe(true);
  });

  it("drains running operations and rejects new mutations while draining", async () => {
    const release = beginRegisteredOperation(crypto.randomUUID(), "fixture", crypto.randomUUID());
    const draining = drainOperations(500);
    expect(lifecycleState()).toBe("DRAINING");
    expect(() => beginRegisteredOperation(crypto.randomUUID(), "new")).toThrow("draining");
    setTimeout(release, 10);
    await expect(draining).resolves.toEqual({ timedOut: false, remaining: [] });
    expect(lifecycleState()).toBe("STOPPED");
  });
});
