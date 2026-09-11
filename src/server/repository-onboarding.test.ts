import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneGitHubProject, createLocalProject, initializeLocalProject, listRepositories, parseGitHubProjectUrl, setRepositoryOnboardingHookForTests, validateRepository } from "./repositories";
import { runGit } from "./git";
import { createTask, deleteTask } from "./tasks";

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "multiagents-onboarding-")); roots.push(value); const code = join(value, "code"); await mkdir(code); return code; }
async function remote(rootPath: string) { const source = join(rootPath, "source"); await mkdir(source); await runGit(source, ["init", "-b", "main"]); await runGit(source, ["config", "user.email", "test@example.com"]); await runGit(source, ["config", "user.name", "Test"]); await (await import("node:fs/promises")).writeFile(join(source, "README.md"), "fixture\n"); await runGit(source, ["add", "README.md"]); await runGit(source, ["commit", "-m", "initial"]); return source; }
afterEach(async () => { setRepositoryOnboardingHookForTests(); await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("repository onboarding", () => {
  it("creates a safe local project, optionally writes a README, and discovery keeps existing repositories", async () => {
    const code = await root();
    const first = await createLocalProject("Existing", false, code);
    const created = await createLocalProject("MyApp", true, code);
    expect(first.id).toBe("Existing"); expect(created.id).toBe("MyApp");
    expect(await readFile(join(created.path, "README.md"), "utf8")).toContain("# MyApp");
    expect((await listRepositories(code)).map((item) => item.id)).toEqual(["Existing", "MyApp"]);
    await expect(createLocalProject("MyApp", false, code)).rejects.toThrow("already exists");
  });

  it("clones a validated GitHub project and checks its final origin identity", async () => {
    const code = await root(); const source = await remote(code);
    const repo = await cloneGitHubProject("https://github.com/example/SafeProject.git", code, async (cwd, _url, target) => {
      await runGit(cwd, ["clone", "--", source, target]); await runGit(target, ["remote", "set-url", "origin", "https://github.com/example/SafeProject.git"]);
    });
    expect(repo.id).toBe("SafeProject"); expect((await listRepositories(code)).some((item) => item.id === "SafeProject")).toBe(true);
  });

  it("rejects non-GitHub URLs, injection-shaped SSH URLs, traversal, and duplicate target names", async () => {
    for (const url of ["file:///tmp/repo", "https://gitlab.com/a/b", "https://github.com.evil/a/b", "https://user@github.com/a/b", "https://github.com:443/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b#x", " https://github.com/a/b", "git@github.com:owner/repo.git;whoami", "git@github.com:-owner/repo", "https://github.com/../repo"]) expect(() => parseGitHubProjectUrl(url)).toThrow("not supported");
    const code = await root();
    for (const name of ["../x", "a/b", "", " name", "a\\b"]) await expect(createLocalProject(name, false, code)).rejects.toThrow("Project name is invalid");
  });

  it("removes only this operation's partial clone on failure", async () => {
    const code = await root();
    await expect(cloneGitHubProject("https://github.com/example/Partial.git", code, async (_cwd, _url, target) => { await mkdir(target); throw new Error("clone failed"); })).rejects.toThrow("clone failed");
    await expect((await import("node:fs/promises")).lstat(join(code, "Partial"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(code, ".multiagents-onboarding"))).resolves.toBeDefined();
  });

  it("keeps a staged clone invisible until validation and publication complete", async () => {
    const code = await root(); const source = await remote(code);
    let release!: () => void; let staged!: () => void; const paused = new Promise<void>((resolve) => { release = resolve; }); const stagedReady = new Promise<void>((resolve) => { staged = resolve; });
    const operation = cloneGitHubProject("https://github.com/example/Invisible.git", code, async (cwd, _url, target) => {
      await runGit(cwd, ["clone", "--", source, target]); await runGit(target, ["remote", "set-url", "origin", "https://github.com/example/Invisible.git"]); staged(); await paused;
    });
    await stagedReady;
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("Invisible");
    release(); await expect(operation).resolves.toMatchObject({ id: "Invisible" });
    expect((await listRepositories(code)).map((repo) => repo.id)).toContain("Invisible");
  });

  it("serializes same-name clones without deleting the winning project", async () => {
    const code = await root(); const source = await remote(code);
    let release!: () => void; let staged!: () => void; const paused = new Promise<void>((resolve) => { release = resolve; }); const stagedReady = new Promise<void>((resolve) => { staged = resolve; });
    const first = cloneGitHubProject("https://github.com/example/Race.git", code, async (cwd, _url, target) => {
      await runGit(cwd, ["clone", "--", source, target]); await runGit(target, ["remote", "set-url", "origin", "https://github.com/example/Race.git"]); staged(); await paused;
    });
    await stagedReady;
    await expect(cloneGitHubProject("https://github.com/example/Race.git", code, async () => { throw new Error("must not run"); })).rejects.toThrow("already being added");
    release(); await first;
    await expect(readFile(join(code, "Race", "README.md"), "utf8")).resolves.toBe("fixture\n");
  });

  it("never publishes an origin mismatch or failed staged validation", async () => {
    const code = await root(); const source = await remote(code);
    await expect(cloneGitHubProject("https://github.com/example/WrongOrigin.git", code, async (cwd, _url, target) => {
      await runGit(cwd, ["clone", "--", source, target]); await runGit(target, ["remote", "set-url", "origin", "https://github.com/example/Other.git"]);
    })).rejects.toThrow("origin does not match");
    await expect(cloneGitHubProject("https://github.com/example/NotGit.git", code, async (_cwd, _url, target) => { await mkdir(target); })).rejects.toThrow();
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("WrongOrigin");
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("NotGit");
  });

  it("rejects an existing public destination without treating it as operation cleanup", async () => {
    const code = await root(); await mkdir(join(code, "Occupied")); await writeFile(join(code, "Occupied", "keep.txt"), "user data\n");
    await expect(cloneGitHubProject("https://github.com/example/Occupied.git", code, async () => { throw new Error("must not clone"); })).rejects.toThrow("already exists");
    await expect(readFile(join(code, "Occupied", "keep.txt"), "utf8")).resolves.toBe("user data\n");
  });

  it("initializes only the verified starter README and preserves the user's index", async () => {
    const code = await root(); const repo = await createLocalProject("Indexed", true, code);
    await writeFile(join(repo.path, "secret.txt"), "not authorized\n"); await runGit(repo.path, ["add", "--", "secret.txt"]);
    const secretBefore = await runGit(repo.path, ["ls-files", "--stage", "--", "secret.txt"]);
    const initialized = await initializeLocalProject(repo.id, code);
    expect(initialized.initializationRequired).toBe(false);
    expect(await runGit(repo.path, ["ls-files", "--stage", "--", "secret.txt"])).toBe(secretBefore);
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("A  secret.txt");
    expect(await runGit(repo.path, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("README.md");
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("already has an initial commit");
  });

  it("creates a genuinely empty initial commit when no server starter README exists", async () => {
    const code = await root(); const repo = await createLocalProject("Empty", false, code);
    await writeFile(join(repo.path, "untracked.txt"), "leave me alone\n");
    await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("");
    expect(await readFile(join(repo.path, "untracked.txt"), "utf8")).toBe("leave me alone\n");
  });

  it("makes a fresh starter project clean and ready for task work after initialization", async () => {
    const code = await root(); const repo = await createLocalProject("Ready", true, code);
    await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("");
    expect(await runGit(repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("README.md");
  });

  it("derives deferred initialization from Git state and permits exactly one initialization", async () => {
    const code = await root(); const repo = await createLocalProject("Deferred", true, code);
    expect((await listRepositories(code)).find((item) => item.id === repo.id)?.initializationRequired).toBe(true);
    const results = await Promise.allSettled([initializeLocalProject(repo.id, code), initializeLocalProject(repo.id, code)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await listRepositories(code)).find((item) => item.id === repo.id)?.initializationRequired).toBe(false);
  });

  it("rejects changed or symlinked starter README files without committing them", async () => {
    const code = await root(); const changed = await createLocalProject("Changed", true, code);
    await writeFile(join(changed.path, "README.md"), "user edit\n");
    await expect(initializeLocalProject(changed.id, code)).rejects.toThrow("Starter README was changed");
    const linked = await createLocalProject("Linked", true, code); await rm(join(linked.path, "README.md")); await writeFile(join(linked.path, "other.md"), "x\n"); await symlink("other.md", join(linked.path, "README.md"));
    await expect(initializeLocalProject(linked.id, code)).rejects.toThrow("no longer safe");
  });

  it("rejects deletion of a starter README that onboarding recorded as expected", async () => {
    const code = await root(); const repo = await createLocalProject("DeletedStarter", true, code);
    await rm(join(repo.path, "README.md"));
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("Starter README is missing");
    await expect(runGit(repo.path, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
  });

  it("never discovers the reserved onboarding directory, its aliases, or incomplete publication", async () => {
    const code = await root(); const internal = join(code, ".multiagents-onboarding"); await mkdir(internal);
    await runGit(internal, ["init", "--initial-branch=main"]);
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain(".multiagents-onboarding");
    const incomplete = join(code, "Incomplete"); await mkdir(incomplete); await runGit(incomplete, ["init", "--initial-branch=main"]);
    const projects = join(internal, "projects"); await mkdir(projects); const hash = (await import("node:crypto")).createHash("sha256").update(incomplete).digest("hex"); await writeFile(join(projects, `${hash}.json`), JSON.stringify({ version: 1, expectedStarter: false }));
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("Incomplete");
    const failed = join(internal, "failed-repo"); await mkdir(failed); await runGit(failed, ["init", "--initial-branch=main"]); await symlink(failed, join(code, "Recovered"));
    await expect(validateRepository("Recovered", code)).rejects.toThrow("reserved onboarding area");
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("Recovered");
  });

  it("quarantines a replaced staging directory instead of deleting it", async () => {
    const code = await root(); let replacement = "";
    await expect(cloneGitHubProject("https://github.com/example/Quarantine.git", code, async (_cwd, _url, target) => {
      const staging = dirname(target); const original = `${staging}-original`; replacement = staging;
      await rename(staging, original); await mkdir(staging); await writeFile(join(staging, "unrelated.txt"), "keep\n"); throw new Error("clone failed");
    })).rejects.toThrow("clone failed");
    await expect(readFile(join(replacement, "unrelated.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("commits verified README bytes even if the worktree changes after verification", async () => {
    const code = await root(); const repo = await createLocalProject("Verified", true, code);
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "after-readme-verification") await writeFile(join(details.repoPath!, "README.md"), "replacement\n"); });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("Starter README was changed");
    expect(await runGit(repo.path, ["show", "HEAD:README.md"])).toBe("# Verified\n\nThis project was created with MultiAgents.");
  });

  it("allows only one alias of the same repository to initialize", async () => {
    const code = await root(); const repo = await createLocalProject("Canonical", false, code); await symlink(repo.path, join(code, "Alias"));
    const results = await Promise.allSettled([initializeLocalProject("Canonical", code), initializeLocalProject("Alias", code)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("loses safely when another initial ref wins before publication", async () => {
    const code = await root(); const repo = await createLocalProject("Winner", false, code);
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-initial-ref") { await writeFile(join(details.repoPath!, "winner.txt"), "winner\n"); await runGit(details.repoPath!, ["add", "winner.txt"]); await runGit(details.repoPath!, ["-c", "user.name=External", "-c", "user.email=external@example.test", "commit", "-m", "external winner"]); } });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("initialized by another process");
    expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await runGit(repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("winner.txt");
  });

  it("refuses a raced leaf symlink without writing through it", async () => {
    const code = await root(); const outside = join(await root(), "outside.txt"); await writeFile(outside, "unchanged\n");
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-publication-copy") await symlink(outside, join(details.target!, "README.md")); });
    await expect(createLocalProject("LeafRace", true, code)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("unchanged\n");
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("LeafRace");
  });

  it("refuses a raced parent symlink without escaping the final project", async () => {
    const code = await root(); const source = await remote(code); await mkdir(join(source, "nested")); await writeFile(join(source, "nested", "safe.txt"), "safe\n"); await runGit(source, ["add", "nested/safe.txt"]); await runGit(source, ["commit", "-m", "nested"]);
    const outside = join(await root(), "outside-dir"); await mkdir(outside); await writeFile(join(outside, "safe.txt"), "unchanged\n");
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-publication-copy") await symlink(outside, join(details.target!, "nested")); });
    await expect(cloneGitHubProject("https://github.com/example/ParentRace.git", code, async (cwd, _url, target) => { await runGit(cwd, ["clone", "--", source, target]); await runGit(target, ["remote", "set-url", "origin", "https://github.com/example/ParentRace.git"]); })).rejects.toThrow();
    expect(await readFile(join(outside, "safe.txt"), "utf8")).toBe("unchanged\n");
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("ParentRace");
  });

  it("uses a final origin check after staging has been validated", async () => {
    const code = await root(); const source = await remote(code);
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-publication") await runGit(details.staging!, ["remote", "set-url", "origin", "https://github.com/example/Other.git"]); });
    await expect(cloneGitHubProject("https://github.com/example/FinalOrigin.git", code, async (cwd, _url, target) => { await runGit(cwd, ["clone", "--", source, target]); await runGit(target, ["remote", "set-url", "origin", "https://github.com/example/FinalOrigin.git"]); })).rejects.toThrow("final origin");
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("FinalOrigin");
  });

  it("uses private completion state and never deletes a public marker-shaped file", async () => {
    const code = await root();
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-publication-copy") await writeFile(join(details.target!, ".multiagents-publication-incomplete"), "user file\n"); });
    await expect(createLocalProject("NoPublicMarker", false, code)).resolves.toMatchObject({ id: "NoPublicMarker" });
    expect(await readFile(join(code, "NoPublicMarker", ".multiagents-publication-incomplete"), "utf8")).toBe("user file\n");
    expect((await listRepositories(code)).map((repo) => repo.id)).toContain("NoPublicMarker");
  });

  it("leaves publication undiscoverable when private completion cannot advance", async () => {
    const code = await root();
    setRepositoryOnboardingHookForTests(async (stage, details) => {
      if (stage === "before-completion") {
        const hash = (await import("node:crypto")).createHash("sha256").update(details.target!).digest("hex");
        await writeFile(join(code, ".multiagents-onboarding", "projects", `${hash}.json.ready`), "not-ready\n");
      }
    });
    await expect(createLocalProject("CompletionFailure", false, code)).rejects.toThrow();
    expect((await listRepositories(code)).map((repo) => repo.id)).not.toContain("CompletionFailure");
  });

  it("builds the initial tree from approved objects rather than mutable index state", async () => {
    const code = await root(); const repo = await createLocalProject("ExplicitTree", true, code);
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-initial-tree") await writeFile(join(details.repoPath!, "unrelated.txt"), "not committed\n"); });
    await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["ls-tree", "-r", "HEAD"])).toMatch(/^100644 blob [0-9a-f]+\tREADME\.md$/);
    expect(await runGit(repo.path, ["show", "HEAD:README.md"])).toBe("# ExplicitTree\n\nThis project was created with MultiAgents.");
    expect(await runGit(repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("README.md");
  });

  it("publishes the pinned validated staging object after its ancestor pathname is replaced", async () => {
    const code = await root(); const externalParent = join(await root(), "external-operation"); await mkdir(externalParent);
    const external = join(externalParent, "PinnedSource"); await mkdir(external); await runGit(external, ["init", "--initial-branch=main"]); await writeFile(join(external, "external-data.txt"), "must not publish\n");
    setRepositoryOnboardingHookForTests(async (stage, details) => {
      if (stage === "before-publication") {
        const parent = dirname(details.staging!);
        await rename(parent, `${parent}-moved`);
        await symlink(externalParent, parent);
      }
    });
    const repo = await createLocalProject("PinnedSource", false, code);
    await expect(lstat(join(repo.path, "external-data.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runGit(repo.path, ["rev-parse", "--show-toplevel"])).toBe(repo.path);
  });

  it("recovers crash boundary C (ref established, index sync fails) without a second commit", async () => {
    const code = await root(); const repo = await createLocalProject("RecoverFresh", true, code);
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-initial-ref") await writeFile(join(details.repoPath!, ".git", "index.lock"), "lock\n", { flag: "wx" }); });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("Initial commit was created");
    const sha = await runGit(repo.path, ["rev-parse", "HEAD"]);
    expect(await runGit(repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("README.md");
    expect((await listRepositories(code)).find((item) => item.id === repo.id)).toMatchObject({ initializationRequired: false, initializationRepairRequired: true });
    await rm(join(repo.path, ".git", "index.lock")); setRepositoryOnboardingHookForTests();
    await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("");
    expect((await listRepositories(code)).find((item) => item.id === repo.id)).toMatchObject({ initializationRepairRequired: false });
    const task = await createTask(repo.id, { allowedRoot: code, worktreeRoot: join(await root(), "worktrees") }); await deleteTask(task.id);
  });

  it("recovers crash boundary B (ref established before subsequent transition)", async () => {
    const code = await root(); const repo = await createLocalProject("RecoverBoundaryB", true, code);
    setRepositoryOnboardingHookForTests(async (stage) => { if (stage === "after-initial-ref") throw new Error("interrupt after ref publication"); });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("interrupt after ref publication");
    const sha = await runGit(repo.path, ["rev-parse", "HEAD"]);
    expect((await validateRepository(repo.id, code)).initializationRepairRequired).toBe(true);
    setRepositoryOnboardingHookForTests(); await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect((await validateRepository(repo.id, code)).initializationRepairRequired).toBe(false);
  });

  it("preserves unrelated staged content across index-sync recovery", async () => {
    const code = await root(); const repo = await createLocalProject("RecoverIndexed", true, code);
    await writeFile(join(repo.path, "secret.txt"), "keep staged\n"); await runGit(repo.path, ["add", "--", "secret.txt"]); const before = await runGit(repo.path, ["ls-files", "--stage", "--", "secret.txt"]);
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-initial-ref") await writeFile(join(details.repoPath!, ".git", "index.lock"), "lock\n", { flag: "wx" }); });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("Initial commit was created"); const sha = await runGit(repo.path, ["rev-parse", "HEAD"]);
    await rm(join(repo.path, ".git", "index.lock")); setRepositoryOnboardingHookForTests(); await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await runGit(repo.path, ["ls-files", "--stage", "--", "secret.txt"])).toBe(before);
    expect(await runGit(repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("README.md");
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("A  secret.txt");
  });

  it("rejects index-sync recovery when HEAD no longer matches the trusted initial commit", async () => {
    const code = await root(); const repo = await createLocalProject("RecoverChangedHead", true, code);
    setRepositoryOnboardingHookForTests(async (stage, details) => { if (stage === "before-initial-ref") await writeFile(join(details.repoPath!, ".git", "index.lock"), "lock\n", { flag: "wx" }); });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("Initial commit was created"); await rm(join(repo.path, ".git", "index.lock"));
    await writeFile(join(repo.path, "winner.txt"), "winner\n"); await runGit(repo.path, ["add", "winner.txt"]); await runGit(repo.path, ["-c", "user.name=External", "-c", "user.email=external@example.test", "commit", "-m", "external"]); const winner = await runGit(repo.path, ["rev-parse", "HEAD"]);
    setRepositoryOnboardingHookForTests(); await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("history changed");
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(winner); expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe("2");
  });

  it("resumes crash boundary A from the exact persisted plan while its branch is unborn", async () => {
    const code = await root(); const repo = await createLocalProject("ResumePlan", true, code);
    setRepositoryOnboardingHookForTests(async (stage) => { if (stage === "before-initial-ref") throw new Error("interrupt before ref publication"); });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("interrupt before ref publication");
    const projects = join(code, ".multiagents-onboarding", "projects");
    const pendingName = (await readdir(projects)).find((name) => name.endsWith(".initialization-pending"));
    expect(pendingName).toBeDefined();
    const pending = JSON.parse(await readFile(join(projects, pendingName!), "utf8")) as { commit: string; tree: string };
    await expect(runGit(repo.path, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
    setRepositoryOnboardingHookForTests();
    await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(pending.commit);
    expect(await runGit(repo.path, ["rev-parse", "HEAD^{tree}"])).toBe(pending.tree);
    expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await runGit(repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("README.md");
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("");
    const task = await createTask(repo.id, { allowedRoot: code, worktreeRoot: join(await root(), "worktrees") }); await deleteTask(task.id);
  });

  it("rejects crash boundary A resume when the approved README changed before ref publication", async () => {
    const code = await root(); const repo = await createLocalProject("ResumeChanged", true, code);
    setRepositoryOnboardingHookForTests(async (stage) => { if (stage === "before-initial-ref") throw new Error("interrupt before ref publication"); });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("interrupt before ref publication");
    await writeFile(join(repo.path, "README.md"), "changed after plan\n"); setRepositoryOnboardingHookForTests();
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("Starter README was changed");
    await expect(runGit(repo.path, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
  });

  it("resumes crash boundary D from malformed completion metadata without a second commit", async () => {
    const code = await root(); const repo = await createLocalProject("ResumeCompletion", true, code);
    setRepositoryOnboardingHookForTests(async (stage, details) => {
      if (stage !== "before-initialization-completion") return;
      const hash = (await import("node:crypto")).createHash("sha256").update(details.repoPath!).digest("hex");
      await writeFile(join(code, ".multiagents-onboarding", "projects", `${hash}.json.initialization-complete-malformed.json`), "{partial", { flag: "wx" });
      throw new Error("interrupt completion publication");
    });
    await expect(initializeLocalProject(repo.id, code)).rejects.toThrow("Initial commit was created");
    const sha = await runGit(repo.path, ["rev-parse", "HEAD"]);
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("");
    expect((await validateRepository(repo.id, code)).initializationRepairRequired).toBe(true);
    await expect(createTask(repo.id, { allowedRoot: code, worktreeRoot: join(await root(), "worktrees") })).rejects.toThrow("Project setup must be completed");
    setRepositoryOnboardingHookForTests();
    await initializeLocalProject(repo.id, code);
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect((await validateRepository(repo.id, code)).initializationRepairRequired).toBe(false);
    const task = await createTask(repo.id, { allowedRoot: code, worktreeRoot: join(await root(), "worktrees") }); await deleteTask(task.id);
  });

  it("preserves an occupied completion generation and retries boundary D with a fresh name", async () => {
    const code = await root(); const repo = await createLocalProject("ResumeCompletionCollision", true, code); let occupied = ""; let commitBefore = ""; let countBefore = "";
    setRepositoryOnboardingHookForTests(async (stage, details) => {
      if (stage !== "before-initialization-completion-create" || occupied) return;
      commitBefore = await runGit(repo.path, ["rev-parse", "HEAD"]); countBefore = await runGit(repo.path, ["rev-list", "--count", "HEAD"]);
      occupied = details.target!; await writeFile(occupied, "unrelated completion object\n", { flag: "wx" });
    });
    await initializeLocalProject(repo.id, code);
    const sha = await runGit(repo.path, ["rev-parse", "HEAD"]);
    expect(await readFile(occupied, "utf8")).toBe("unrelated completion object\n");
    expect(sha).toBe(commitBefore);
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await runGit(repo.path, ["rev-list", "--count", "HEAD"])).toBe(countBefore);
    expect((await validateRepository(repo.id, code)).initializationRepairRequired).toBe(false);
    const task = await createTask(repo.id, { allowedRoot: code, worktreeRoot: join(await root(), "worktrees") }); await deleteTask(task.id);
  });
});
