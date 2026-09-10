import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "./git";
import { acquireTaskLock, isTaskLocked, releaseTaskLock } from "./task-lock";
import { StateStore, replaceStateStoreForTests } from "./state-store";
import { clearTasksForTests, createTask, getTask, persistTask, previewManagedWorktreeReassociation, reassociateManagedWorktree, registerRecoveredTask, reloadTasksFromStoreForTests, resumeTask } from "./tasks";

let root: string; let store: StateStore;
const id = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "multiagents-reassociate-")); store = new StateStore(join(root, "state.db")); replaceStateStoreForTests(store); clearTasksForTests(); });
afterEach(async () => { clearTasksForTests(); replaceStateStoreForTests(new StateStore(":memory:")); await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const allowedRoot = join(root, "code"); const worktreeRoot = join(root, "worktrees"); const a = join(allowedRoot, "project"); const b = join(allowedRoot, "project-alt");
  await mkdir(a, { recursive: true }); await runGit(a, ["init", "-b", "main"]); await runGit(a, ["config", "user.email", "test@example.com"]); await runGit(a, ["config", "user.name", "Test"]);
  await writeFile(join(a, "README.md"), "initial\n"); await runGit(a, ["add", "README.md"]); await runGit(a, ["commit", "-m", "initial"]); await runGit(a, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  const task = await createTask("project", { allowedRoot, worktreeRoot });
  await runGit(a, ["worktree", "remove", task.worktreePath]);
  await runGit(allowedRoot, ["clone", a, b]); await runGit(b, ["remote", "set-url", "origin", "https://github.com/example/project.git"]); await runGit(b, ["config", "user.email", "test@example.com"]); await runGit(b, ["config", "user.name", "Test"]);
  const candidate = join(worktreeRoot, "project-alt", id); await mkdir(join(worktreeRoot, "project-alt"), { recursive: true }); await runGit(b, ["worktree", "add", "-b", `multiagents/${id}`, candidate, "HEAD"]);
  task.id = id; task.branch = `multiagents/${id}`; task.worktreePath = join(worktreeRoot, "project", id); task.worktreeAvailable = false; task.worktreeStatus = "missing"; task.status = "pr_created"; task.commitSha = await runGit(candidate, ["rev-parse", "HEAD"]); task.latestPushedSha = task.commitSha; task.prNumber = 1; task.prUrl = "https://github.com/example/project/pull/1"; task.recoveryStatus = "orphaned"; clearTasksForTests(); registerRecoveredTask(task);
  return { allowedRoot, worktreeRoot, a, b, task, candidate };
}

/** A rejected preview must be observational only: it cannot repair or adopt anything. */
async function expectRejectedPreviewToBeNonMutating(f: Awaited<ReturnType<typeof fixture>>) {
  const beforeMemory = JSON.stringify(getTask(f.task.id));
  const beforePersisted = JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id));
  const beforeGit = JSON.stringify({
    head: await runGit(f.candidate, ["rev-parse", "HEAD"]),
    branch: await runGit(f.candidate, ["branch", "--show-current"]),
    status: await runGit(f.candidate, ["status", "--porcelain=v1"]),
    registration: await runGit(f.b, ["worktree", "list", "--porcelain"]),
  });
  await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow();
  expect(JSON.stringify(getTask(f.task.id))).toBe(beforeMemory);
  expect(JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id))).toBe(beforePersisted);
  expect(JSON.stringify({
    head: await runGit(f.candidate, ["rev-parse", "HEAD"]),
    branch: await runGit(f.candidate, ["branch", "--show-current"]),
    status: await runGit(f.candidate, ["status", "--porcelain=v1"]),
    registration: await runGit(f.b, ["worktree", "list", "--porcelain"]),
  })).toBe(beforeGit);
}

describe("Phase 23.1 managed worktree reassociation", () => {
  it("discovers, atomically reassociates, and restart-validates an alternate clone without changing logical identity", async () => {
    const f = await fixture(); const preview = await previewManagedWorktreeReassociation(f.task.id, f);
    expect(preview).toMatchObject({ oldPath: f.task.worktreePath, candidatePath: f.candidate, localClonePath: f.b, branch: f.task.branch, head: f.task.commitSha, prNumber: 1 });
    const result = await reassociateManagedWorktree(f.task.id, preview.fingerprint, f);
    expect(result).toMatchObject({ repoId: "project", repoPath: f.a, localClonePath: f.b, worktreePath: f.candidate, worktreeAvailable: true, worktreeStatus: "available", prNumber: 1, commitSha: f.task.commitSha });
    reloadTasksFromStoreForTests(); const restored = await resumeTask(f.task.id, f);
    expect(restored).toMatchObject({ localClonePath: f.b, worktreePath: f.candidate, worktreeAvailable: true, worktreeStatus: "available" });
  });

  it("rejects stale previews and rolls back an injected persistence failure", async () => {
    const f = await fixture(); const preview = await previewManagedWorktreeReassociation(f.task.id, f); f.task.updatedAt = new Date(Date.now() + 1_000).toISOString(); persistTask(f.task);
    await expect(reassociateManagedWorktree(f.task.id, preview.fingerprint, f)).rejects.toThrow("stale");
    const fresh = await previewManagedWorktreeReassociation(f.task.id, f); const save = vi.spyOn(store, "saveTask").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    await expect(reassociateManagedWorktree(f.task.id, fresh.fingerprint, f)).rejects.toThrow("SQLITE_FULL"); save.mockRestore();
    expect(getTask(f.task.id)).toMatchObject({ localClonePath: undefined, worktreePath: f.task.worktreePath, worktreeAvailable: false, worktreeStatus: "missing" });
  });

  it("reconciles a reassociated task through canonical recovery without stale missing-worktree payload", async () => {
    const f = await fixture(); f.task.prompt = "Restore the original task"; f.task.originalTaskAvailable = false;
    f.task.error = "Task worktree is unavailable. Review intake is read-only; rework is disabled."; persistTask(f.task);
    const preview = await previewManagedWorktreeReassociation(f.task.id, f);
    const result = await reassociateManagedWorktree(f.task.id, preview.fingerprint, f);
    expect(result).toMatchObject({ localClonePath: f.b, worktreePath: f.candidate, worktreeAvailable: true, worktreeStatus: "available", originalTaskAvailable: true, recoveryStatus: "needs_attention" });
    expect(result.error).toBeUndefined();
    expect(result.recoveryMessage).toBe("PR and CI state must be refreshed from GitHub.");
    expect(store.loadTaskHistory(f.task.id).events.filter((event) => event.type === "worktree_reassociated")).toHaveLength(1);
    reloadTasksFromStoreForTests(); const restored = await resumeTask(f.task.id, f);
    expect(restored).toMatchObject({ worktreeAvailable: true, worktreeStatus: "available", originalTaskAvailable: true, recoveryStatus: "needs_attention" });
  });

  it("clears the refresh blocker when persisted PR metadata is current and keeps rework prerequisites truthful", async () => {
    const f = await fixture(); f.task.prompt = "Restore the original task";
    f.task.prReview = { number: 1, title: "test", url: f.task.prUrl!, state: "OPEN", draft: false, merged: false, base: "main", head: f.task.branch, headSha: f.task.commitSha!, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", changedFiles: [], checks: [], items: [], reviewCount: 0, unresolvedCount: 0, fetchedAt: new Date().toISOString() };
    persistTask(f.task);
    const preview = await previewManagedWorktreeReassociation(f.task.id, f);
    const result = await reassociateManagedWorktree(f.task.id, preview.fingerprint, f);
    expect(result).toMatchObject({ worktreeAvailable: true, worktreeStatus: "available", originalTaskAvailable: true, recoveryStatus: "recoverable" });
    expect(result.recoveryMessage).toBeUndefined();
  });

  it("keeps the verified association recoverable when recovery-state persistence fails once", async () => {
    const f = await fixture(); f.task.prompt = "Restore the original task"; persistTask(f.task);
    const preview = await previewManagedWorktreeReassociation(f.task.id, f); const original = store.saveTask.bind(store); const save = vi.spyOn(store, "saveTask"); let calls = 0;
    save.mockImplementation((task) => { calls += 1; if (calls === 2) throw new Error("SQLITE_FULL"); return original(task); });
    const result = await reassociateManagedWorktree(f.task.id, preview.fingerprint, f); save.mockRestore();
    expect(result).toMatchObject({ localClonePath: f.b, worktreePath: f.candidate, worktreeAvailable: true, worktreeStatus: "available", recoveryStatus: "needs_attention" });
    expect(result.recoveryMessage).toContain("could not be persisted");
    expect(store.loadTaskHistory(f.task.id).events.filter((event) => event.type === "worktree_reassociated")).toHaveLength(1);
  });

  it.each([
    ["wrong remote origin", async (f: Awaited<ReturnType<typeof fixture>>) => runGit(f.b, ["remote", "set-url", "origin", "https://github.com/other/project.git"])],
    ["wrong branch", async (f: Awaited<ReturnType<typeof fixture>>) => runGit(f.candidate, ["switch", "-c", "wrong-branch"])],
    ["dirty worktree", async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(join(f.candidate, "README.md"), "dirty\n")],
    ["untracked file", async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(join(f.candidate, "untracked.txt"), "x\n")],
  ])("fails closed for %s", async (_name, mutate) => { const f = await fixture(); await mutate(f); await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("No safe"); });

  it("blocks an active task lock and permits a retry after release", async () => {
    const f = await fixture(); const lease = acquireTaskLock(f.task.id); expect(lease).toBeTruthy();
    await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("blocked");
    if (lease) releaseTaskLock(f.task.id, lease);
    await expect(previewManagedWorktreeReassociation(f.task.id, f)).resolves.toMatchObject({ candidatePath: f.candidate });
  });

  it("rejects candidate ownership by another task and a path symlink", async () => {
    const f = await fixture(); const other = { ...f.task, id: "22222222-2222-4222-8222-222222222222", worktreePath: f.candidate }; clearTasksForTests(); registerRecoveredTask(f.task); registerRecoveredTask(other);
    await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("No safe");
    clearTasksForTests(); registerRecoveredTask(f.task); await rm(f.candidate, { recursive: true, force: true }); await symlink(join(root, "outside"), f.candidate, "dir");
    await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("No safe");
  });

  describe("canonical non-mutating negative matrix", () => {
    it.each([
      ["01 wrong remote origin", async (f: Awaited<ReturnType<typeof fixture>>) => runGit(f.b, ["remote", "set-url", "origin", "https://github.com/other/project.git"])],
      ["02 same commit but different logical repository", async (f: Awaited<ReturnType<typeof fixture>>) => runGit(f.b, ["remote", "set-url", "origin", "git@github.com:other/project.git"])],
      ["03 wrong branch", async (f: Awaited<ReturnType<typeof fixture>>) => runGit(f.candidate, ["switch", "-c", "wrong-branch"])],
      ["04 wrong HEAD", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.candidate, "HEAD-CHANGE"), "x\n"); await runGit(f.candidate, ["add", "HEAD-CHANGE"]); await runGit(f.candidate, ["commit", "-m", "different head"]); }],
      ["05 PR head mismatch", async (f: Awaited<ReturnType<typeof fixture>>) => { f.task.prReview = { number: 1, title: "test", url: f.task.prUrl!, state: "OPEN", draft: false, merged: false, base: "main", head: f.task.branch, headSha: "0".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", changedFiles: [], checks: [], items: [], reviewCount: 0, unresolvedCount: 0, fetchedAt: new Date().toISOString() }; persistTask(f.task); }],
      ["06 dirty worktree", async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(join(f.candidate, "README.md"), "dirty\n")],
      ["07 untracked files", async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(join(f.candidate, "untracked.txt"), "x\n")],
      ["09 nested repository", async (f: Awaited<ReturnType<typeof fixture>>) => mkdir(join(f.candidate, "nested", ".git"), { recursive: true })],
    ])("%s", async (_name, mutate) => { const f = await fixture(); await mutate(f); await expectRejectedPreviewToBeNonMutating(f); });

    it("08 symlink/path escape", async () => {
      const f = await fixture(); const beforeMemory = JSON.stringify(getTask(f.task.id)); const beforePersisted = JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id));
      await rm(f.candidate, { recursive: true, force: true }); await mkdir(join(root, "outside")); await symlink(join(root, "outside"), f.candidate, "dir");
      const beforePath = await readlink(f.candidate);
      await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("No safe");
      expect(JSON.stringify(getTask(f.task.id))).toBe(beforeMemory); expect(JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id))).toBe(beforePersisted);
      expect(await readlink(f.candidate)).toBe(beforePath);
    });

    it("10 unsafe alternate clone", async () => {
      const f = await fixture(); const beforeMemory = JSON.stringify(getTask(f.task.id)); const beforePersisted = JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id));
      await runGit(f.b, ["config", "core.editor", "/bin/false"]);
      const beforeConfig = await readFile(join(f.b, ".git", "config"), "utf8");
      await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("No safe");
      expect(JSON.stringify(getTask(f.task.id))).toBe(beforeMemory); expect(JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id))).toBe(beforePersisted);
      expect(await readFile(join(f.b, ".git", "config"), "utf8")).toBe(beforeConfig);
    });

    it("11 linked-worktree parent/registration mismatch", async () => {
      const f = await fixture(); await runGit(f.b, ["worktree", "remove", f.candidate]); await runGit(f.a, ["worktree", "add", "-b", f.task.branch, f.candidate, "HEAD"]);
      await expectRejectedPreviewToBeNonMutating(f);
    });

    it("12 worktree currently in use", async () => {
      const f = await fixture(); const child = spawn("sleep", ["20"], { cwd: f.candidate });
      try { await new Promise((resolve) => setTimeout(resolve, 25)); await expectRejectedPreviewToBeNonMutating(f); }
      finally { child.kill(); }
    });

    it("13 active task/validation conflict", async () => {
      const f = await fixture(); const lease = acquireTaskLock(f.task.id); expect(lease).toBeTruthy();
      const beforeMemory = JSON.stringify(getTask(f.task.id)); const beforePersisted = JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id));
      const beforeGit = await runGit(f.candidate, ["status", "--porcelain=v1"]);
      try { await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("blocked"); expect(JSON.stringify(getTask(f.task.id))).toBe(beforeMemory); expect(JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id))).toBe(beforePersisted); }
      finally { if (lease) releaseTaskLock(f.task.id, lease); }
      expect(await runGit(f.candidate, ["status", "--porcelain=v1"])).toBe(beforeGit);
      expect(isTaskLocked(f.task.id)).toBe(false);
    });

    it("14 stale preview / registration changed after preview", async () => {
      const f = await fixture(); const preview = await previewManagedWorktreeReassociation(f.task.id, f); const beforeMemory = JSON.stringify(getTask(f.task.id)); const beforePersisted = JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id));
      const extra = join(f.worktreeRoot, "project-alt", "extra-registration"); await runGit(f.b, ["worktree", "add", "-b", "extra-registration", extra, "HEAD"]);
      const beforeRegistration = await runGit(f.b, ["worktree", "list", "--porcelain"]);
      await expect(reassociateManagedWorktree(f.task.id, preview.fingerprint, f)).rejects.toThrow("stale");
      expect(JSON.stringify(getTask(f.task.id))).toBe(beforeMemory); expect(JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id))).toBe(beforePersisted); expect(await runGit(f.b, ["worktree", "list", "--porcelain"])).toBe(beforeRegistration); expect(isTaskLocked(f.task.id)).toBe(false);
    });

    it("15 already-associated healthy task", async () => {
      const f = await fixture(); f.task.worktreePath = f.candidate; f.task.worktreeAvailable = true; f.task.worktreeStatus = "available"; persistTask(f.task);
      await expectRejectedPreviewToBeNonMutating(f);
    });

    it("16 candidate owned by another task", async () => {
      const f = await fixture(); const other = { ...f.task, id: "22222222-2222-4222-8222-222222222222", worktreePath: f.candidate }; registerRecoveredTask(other);
      await expectRejectedPreviewToBeNonMutating(f);
    });

    it("17 task-ID/path identity mismatch", async () => {
      const f = await fixture(); const beforeMemory = JSON.stringify(getTask(f.task.id)); const beforePersisted = JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id));
      await runGit(f.b, ["worktree", "remove", f.candidate]); const wrongPath = join(f.worktreeRoot, "project-alt", "33333333-3333-4333-8333-333333333333"); await runGit(f.b, ["worktree", "add", wrongPath, "HEAD"]);
      const beforeRegistration = await runGit(f.b, ["worktree", "list", "--porcelain"]);
      await expect(previewManagedWorktreeReassociation(f.task.id, f)).rejects.toThrow("No safe");
      expect(JSON.stringify(getTask(f.task.id))).toBe(beforeMemory); expect(JSON.stringify(store.loadTasks().find((task) => task.id === f.task.id))).toBe(beforePersisted); expect(await runGit(f.b, ["worktree", "list", "--porcelain"])).toBe(beforeRegistration);
    });
  });
});
