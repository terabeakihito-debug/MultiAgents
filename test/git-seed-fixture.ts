import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type GitSeedFixture = { repositoryPath: string; cleanup: () => Promise<void> };

/** A test-only immutable seed; clones are independent and never hard-link objects. */
export async function createGitSeedFixture(files: Readonly<Record<string, string>>): Promise<GitSeedFixture> {
  const root = await mkdtemp(join(tmpdir(), "multiagents-git-seed-"));
  const repositoryPath = join(root, "seed");
  try {
    await mkdir(repositoryPath);
    await fixtureGit(repositoryPath, ["init", "-b", "main"]);
    await fixtureGit(repositoryPath, ["config", "user.email", "test@example.com"]);
    await fixtureGit(repositoryPath, ["config", "user.name", "Test"]);
    for (const [name, content] of Object.entries(files)) {
      const path = join(repositoryPath, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    await fixtureGit(repositoryPath, ["add", "."]);
    await fixtureGit(repositoryPath, ["commit", "-m", "fixture"]);
    return { repositoryPath, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function cloneGitSeedFixture(seed: GitSeedFixture, target: string, originUrl: string) {
  await mkdir(dirname(target), { recursive: true });
  await fixtureGit(dirname(target), ["clone", "--local", "--no-hardlinks", seed.repositoryPath, target]);
  await fixtureGit(target, ["config", "user.email", "test@example.com"]);
  await fixtureGit(target, ["config", "user.name", "Test"]);
  await fixtureGit(target, ["remote", "set-url", "origin", originUrl]);
}

/** Fixture construction only; production paths retain the hardened Git helper. */
async function fixtureGit(cwd: string, args: readonly string[]) {
  await execute("/usr/bin/git", ["--no-pager", ...args], {
    cwd,
    shell: false,
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat" },
  });
}
