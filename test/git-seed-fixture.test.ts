import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "../src/server/git";
import { cloneGitSeedFixture, createGitSeedFixture } from "./git-seed-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("test Git seed fixture", () => {
  it("creates an independent no-hardlink clone with the requested origin", async () => {
    const seed = await createGitSeedFixture({ "README.md": "seed\n" }); cleanups.push(seed.cleanup);
    const root = await mkdtemp(join(tmpdir(), "multiagents-git-seed-clone-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const clone = join(root, "clone");
    await cloneGitSeedFixture(seed, clone, "https://github.com/example/project.git");
    expect(await runGit(clone, ["rev-parse", "HEAD"])).toBe(await runGit(seed.repositoryPath, ["rev-parse", "HEAD"]));
    expect(await runGit(clone, ["remote", "get-url", "origin"])).toBe("https://github.com/example/project.git");
    expect(await runGit(clone, ["config", "user.name"])).toBe("Test");
    await writeFile(join(clone, "README.md"), "changed\n");
    expect(await readFile(join(seed.repositoryPath, "README.md"), "utf8")).toBe("seed\n");
  });
});
