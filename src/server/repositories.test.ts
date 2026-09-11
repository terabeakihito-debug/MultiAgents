import { lstat, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "./git";
import { createLocalProject, initializeLocalProject, listRepositories, validateRepository } from "./repositories";
import { clearTasksForTests, createTask, deleteTask, getTaskDiff } from "./tasks";

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "multiagents-test-")); roots.push(value); return value; }
async function repo(parent: string, name: string) {
  const path = join(parent, name); await mkdir(path); await runGit(path, ["init", "-b", "main"]);
  await runGit(path, ["config", "user.email", "test@example.com"]); await runGit(path, ["config", "user.name", "Test"]);
  await writeFile(join(path, "README.md"), "initial\n"); await runGit(path, ["add", "README.md"]); await runGit(path, ["commit", "-m", "initial"]); return path;
}
afterEach(() => clearTasksForTests());

describe("repository discovery and isolated worktrees", () => {
  it("lists only direct clean Git repositories", async () => {
    const allowed = await root(); await repo(allowed, "good"); await mkdir(join(allowed, "plain"));
    expect((await listRepositories(allowed)).map((item) => item.id)).toEqual(["good"]);
  });
  it("rejects path injection and repositories outside the root", async () => {
    const allowed = await root(); const outside = await root(); await repo(outside, "escape");
    await expect(validateRepository("../escape", allowed)).rejects.toThrow("Invalid repository id");
    await symlink(join(outside, "escape"), join(allowed, "linked"));
    await expect(validateRepository("linked", allowed)).rejects.toThrow("outside the allowed root");
    await expect(validateRepository("/mnt/c/repo", allowed)).rejects.toThrow("Invalid repository id");
    await expect(createTask("evil;branch", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") })).rejects.toThrow("Invalid repository id");
  });
  it("rejects a canonical alias into quarantined onboarding state for validation, listing, and tasks", async () => {
    const allowed = await root(); const onboarding = join(allowed, ".multiagents-onboarding"); await mkdir(onboarding);
    const failed = await repo(onboarding, "failed"); await symlink(failed, join(allowed, "Recovered"));
    await expect(validateRepository("Recovered", allowed)).rejects.toThrow("reserved onboarding area");
    expect((await listRepositories(allowed)).map((item) => item.id)).not.toContain("Recovered");
    await expect(createTask("Recovered", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") })).rejects.toThrow("reserved onboarding area");
  });
  it("rejects dirty source repositories", async () => {
    const allowed = await root(); const path = await repo(allowed, "dirty"); await writeFile(join(path, "README.md"), "changed\n");
    await expect(createTask("dirty", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") })).rejects.toThrow("uncommitted changes");
  });
  it("rejects task creation for an uninitialized project before worktree processing", async () => {
    const allowed = await root(); const created = await createLocalProject("uninitialized", false, allowed);
    expect((await validateRepository(created.id, allowed)).initializationRequired).toBe(true);
    await expect(createTask(created.id, { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") })).rejects.toThrow("Project must be initialized");
  });
  it("allows task creation from a freshly initialized starter project", async () => {
    const allowed = await root(); const created = await createLocalProject("beginner", true, allowed);
    await initializeLocalProject(created.id, allowed);
    expect(await runGit(created.path, ["status", "--porcelain"])).toBe("");
    const task = await createTask(created.id, { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") });
    await deleteTask(task.id);
  });
  it("creates a server-named branch, uses its worktree, and acquires diff", async () => {
    const allowed = await root(); await repo(allowed, "clean");
    const task = await createTask("clean", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") });
    expect(task.branch).toMatch(/^multiagents\/[0-9a-f-]{36}$/);
    expect(await runGit(task.worktreePath, ["branch", "--show-current"])).toBe(task.branch);
    await writeFile(join(task.worktreePath, "README.md"), "initial\nisolated\n");
    const diff = await getTaskDiff(task); expect(diff.approvable, diff.blockedReason).toBe(true); expect(diff.stat).toContain("README.md"); expect(diff.patch).toContain("+isolated");
    expect(await runGit(join(allowed, "clean"), ["status", "--porcelain"])).toBe("");
    await expect(deleteTask(task.id)).rejects.toThrow("uncommitted changes");
    await runGit(task.worktreePath, ["restore", "README.md"]); await deleteTask(task.id);
  });
  it("fails closed and retains the worktree when the authoritative status check fails", async () => {
    const allowed = await root(); await repo(allowed, "status-failure");
    const task = await createTask("status-failure", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") });
    // Make the status invocation fail before it can reach worktree removal.
    await runGit(task.repoPath, ["config", "extensions.worktreeConfig", "true"]);
    await runGit(task.worktreePath, ["config", "--worktree", "filter.evil.clean", "/tmp/evil-filter"]);

    await expect(deleteTask(task.id)).rejects.toThrow("Git config is not allowed");
    await expect(lstat(task.worktreePath)).resolves.toBeDefined();
    expect(task.worktreeStatus).toBe("available");
  });
  it("shows every untracked approval entry, identifies binary, and renders a symlink target without reading its target", async () => {
    const allowed = await root(); await repo(allowed, "files");
    const task = await createTask("files", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") });
    await writeFile(join(task.worktreePath, "new.txt"), "こんにちは\n");
    await writeFile(join(task.worktreePath, "image.bin"), Buffer.from([0, 1, 2]));
    await mkdir(join(task.worktreePath, "node_modules")); await writeFile(join(task.worktreePath, "node_modules", "secret.txt"), "excluded");
    const outside = join(await root(), "outside.txt"); await writeFile(outside, "must not be read"); await symlink(outside, join(task.worktreePath, "escape.txt"));
    const diff = await getTaskDiff(task);
    expect(diff.untrackedFiles).toEqual(["escape.txt", "image.bin", "new.txt", "node_modules/secret.txt"]);
    expect(diff.untrackedPatch).toContain("+こんにちは");
    expect(diff.untrackedPatch).toContain("[binary content omitted]");
    expect(diff.untrackedPatch).toContain("symlink target:");
    expect(diff.untrackedPatch).not.toContain("must not be read");
    expect(diff.untrackedPatch).toContain("excluded");
    expect(diff.approvable).toBe(false);
  });
});
