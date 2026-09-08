import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "./git";
import { clearTasksForTests, createTask, deleteTask } from "./tasks";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multiagents-safe-git-"));
  roots.push(root);
  const allowed = join(root, "code"); const repo = join(allowed, "project");
  await mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await runGit(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await runGit(repo, ["add", "README.md"]); await runGit(repo, ["commit", "-m", "initial"]);
  return { root, allowed, repo, marker: join(root, "executed") };
}

async function executable(path: string, marker: string) {
  await writeFile(path, `#!/bin/sh\nprintf executed > ${marker}\n`);
  await chmod(path, 0o700);
}

afterEach(async () => {
  clearTasksForTests();
  await Promise.all(roots.splice(0).map(async (root) => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); }));
});

describe("Phase 21A safe Git execution", () => {
  it("prevents fsmonitor and hooks from executing during discovery, status, worktree creation, and cleanup", async () => {
    const { root, allowed, repo, marker } = await fixture();
    const monitor = join(root, "monitor"); const hooks = join(root, "hooks");
    await executable(monitor, marker); await mkdir(hooks); await executable(join(hooks, "pre-commit"), marker);
    await runGit(repo, ["config", "core.fsmonitor", monitor]);
    await runGit(repo, ["config", "core.hooksPath", hooks]);
    expect(await runGit(repo, ["status", "--porcelain"])).toBe("");
    const task = await createTask("project", { allowedRoot: allowed, worktreeRoot: join(allowed, "worktrees") });
    await writeFile(join(task.worktreePath, "README.md"), "changed\n");
    await runGit(task.worktreePath, ["add", "README.md"]);
    await runGit(task.worktreePath, ["commit", "-m", "safe test commit"]);
    await deleteTask(task.id);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["filter.clean", ["filter.evil.clean", "./marker"], ["add", "README.md"]],
    ["filter.smudge/process", ["filter.evil.process", "./marker"], ["status", "--porcelain"]],
    ["diff.external", ["diff.external", "./marker"], ["diff", "HEAD"]],
    ["textconv", ["diff.evil.textconv", "./marker"], ["diff", "HEAD"]],
    ["include", ["include.path", "./included-config"], ["status", "--porcelain"]],
  ] as const)("rejects %s configuration before Git can execute it", async (_label, [key, value], command) => {
    const { repo, marker } = await fixture();
    await executable(join(repo, "marker"), marker);
    await runGit(repo, ["config", key, value]);
    await expect(runGit(repo, command)).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores GIT_EXTERNAL_DIFF and keeps a normal repository usable", async () => {
    const { repo, marker } = await fixture();
    await executable(join(repo, "external-diff"), marker);
    await writeFile(join(repo, "README.md"), "changed\n");
    const previous = process.env.GIT_EXTERNAL_DIFF;
    process.env.GIT_EXTERNAL_DIFF = join(repo, "external-diff");
    try {
      expect(await runGit(repo, ["diff", "HEAD"])).toContain("changed");
      expect(await runGit(repo, ["status", "--porcelain"])).toContain("README.md");
    } finally {
      if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = previous;
    }
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
