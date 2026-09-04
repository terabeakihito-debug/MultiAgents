import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "./git";
import { listRepositories, validateRepository } from "./repositories";
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
  it("rejects dirty source repositories", async () => {
    const allowed = await root(); const path = await repo(allowed, "dirty"); await writeFile(join(path, "README.md"), "changed\n");
    await expect(createTask("dirty", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") })).rejects.toThrow("uncommitted changes");
  });
  it("creates a server-named branch, uses its worktree, and acquires diff", async () => {
    const allowed = await root(); await repo(allowed, "clean");
    const task = await createTask("clean", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") });
    expect(task.branch).toMatch(/^multiagents\/[0-9a-f-]{36}$/);
    expect(await runGit(task.worktreePath, ["branch", "--show-current"])).toBe(task.branch);
    await writeFile(join(task.worktreePath, "README.md"), "initial\nisolated\n");
    const diff = await getTaskDiff(task); expect(diff.stat).toContain("README.md"); expect(diff.patch).toContain("+isolated");
    expect(await runGit(join(allowed, "clean"), ["status", "--porcelain"])).toBe("");
    await expect(deleteTask(task.id)).rejects.toThrow("uncommitted changes");
    await runGit(task.worktreePath, ["restore", "README.md"]); await deleteTask(task.id);
  });
  it("shows safe untracked text, identifies binary, excludes build directories, and omits symlink content", async () => {
    const allowed = await root(); await repo(allowed, "files");
    const task = await createTask("files", { allowedRoot: allowed, worktreeRoot: join(await root(), "worktrees") });
    await writeFile(join(task.worktreePath, "new.txt"), "こんにちは\n");
    await writeFile(join(task.worktreePath, "image.bin"), Buffer.from([0, 1, 2]));
    await mkdir(join(task.worktreePath, "node_modules")); await writeFile(join(task.worktreePath, "node_modules", "secret.txt"), "excluded");
    const outside = join(await root(), "outside.txt"); await writeFile(outside, "must not be read"); await symlink(outside, join(task.worktreePath, "escape.txt"));
    const diff = await getTaskDiff(task);
    expect(diff.untrackedFiles).toEqual(["escape.txt", "image.bin", "new.txt"]);
    expect(diff.untrackedPatch).toContain("+こんにちは");
    expect(diff.untrackedPatch).toContain("Binary/untracked file");
    expect(diff.untrackedPatch).toContain("Untracked symlink (content omitted)");
    expect(diff.untrackedPatch).not.toContain("must not be read");
    expect(diff.untrackedPatch).not.toContain("excluded");
  });
});
