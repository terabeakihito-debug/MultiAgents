import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeChildProcesses } from "./child-process-registry";
import { lsRemoteTransport, pushCommitTransport, runGit, runGitBytes, setGitCommandTimeoutForTests, setGitTransportRootForTests } from "./git";
import { createDiffSnapshot, runServerGitMutation } from "./pull-request";
import { clearTasksForTests, createTask, deleteTask } from "./tasks";

const roots: string[] = [];
const timeoutChild = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => timeoutChild.enabled
      ? actual.spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], args[2])
      : actual.spawn(...args),
  };
});

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
  setGitTransportRootForTests(join(root, "transport-runtime", "git-transport"));
  return { root, allowed, repo, marker: join(root, "executed") };
}

async function executable(path: string, marker: string) {
  await writeFile(path, `#!/bin/sh\nprintf executed > ${marker}\n`);
  await chmod(path, 0o700);
}

afterEach(async () => {
  setGitTransportRootForTests();
  setGitCommandTimeoutForTests();
  timeoutChild.enabled = false;
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

  it.each([
    ["quoted section with trailing comment", `[diff "evil"] # comment\n\ttextconv = MARKER`],
    ["legacy dotted section", "[diff.evil]\n\ttextconv = MARKER"],
    ["same-line assignment", `[diff "evil"] textconv = MARKER`],
  ])("rejects canonical %s textconv syntax before diff execution", async (_label, config) => {
    const { repo, marker } = await fixture();
    const script = join(repo, "marker"); await executable(script, marker);
    await writeFile(join(repo, ".gitattributes"), "README.md diff=evil\n");
    await writeFile(join(repo, "README.md"), "changed\n");
    await writeFile(join(repo, ".git", "config"), `${await readFile(join(repo, ".git", "config"), "utf8")}\n${config.replace("MARKER", script)}\n`);
    await expect(runGit(repo, ["diff", "HEAD"])).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects trailing-comment filters before snapshot, staging, and worktree creation", async () => {
    const { root, repo, marker } = await fixture();
    const script = join(repo, "marker"); await executable(script, marker);
    await writeFile(join(repo, ".gitattributes"), "README.md filter=evil\n");
    await runGit(repo, ["add", ".gitattributes"]); await runGit(repo, ["commit", "-m", "attributes"]);
    await writeFile(join(repo, "README.md"), "changed\n");
    await writeFile(join(repo, ".git", "config"), `${await readFile(join(repo, ".git", "config"), "utf8")}\n[filter "evil"] # comment\n\tclean = ${script}\n\tsmudge = ${script}\n`);
    const task = { worktreePath: repo } as never;
    await expect(createDiffSnapshot(task)).rejects.toThrow("Git config is not allowed");
    await expect(runServerGitMutation(repo, ["add", "--all"])).rejects.toThrow("Git config is not allowed");
    await expect(runGit(repo, ["worktree", "add", "--detach", join(root, "extra"), "HEAD"])).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["smudge filter", "filter.evil.smudge", "./marker"],
    ["process filter", "filter.evil.process", "./marker"],
    ["merge driver", "merge.evil.driver", "./marker"],
    ["SSH command", "core.sshCommand", "./marker"],
    ["credential helper", "credential.helper", "!/bin/sh ./marker"],
    ["includeIf", "includeIf.gitdir:*/.path", "./included-config"],
  ])("rejects %s configuration", async (_label, key, value) => {
    const { repo, marker } = await fixture();
    await executable(join(repo, "marker"), marker);
    await runGit(repo, ["config", key, value]);
    await expect(runGit(repo, ["status", "--porcelain"])).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("strips Git execution-control environment variables", async () => {
    const { repo, root, marker } = await fixture();
    const script = join(repo, "marker"); await executable(script, marker);
    await writeFile(join(repo, "README.md"), "changed\n");
    const output = await runGitBytes(repo, ["diff", "HEAD"], {
      PATH: process.env.PATH,
      NODE_ENV: process.env.NODE_ENV ?? "test",
      GIT_EXTERNAL_DIFF: script,
      GIT_SSH_COMMAND: script,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "diff.external",
      GIT_CONFIG_VALUE_0: script,
      GIT_OBJECT_DIRECTORY: join(root, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, "alternate-objects"),
      GIT_REPLACE_REF_BASE: "refs/replace/",
      GIT_NAMESPACE: "evil",
    });
    expect(output.toString("utf8")).toContain("changed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("screens the repository Git found from a subdirectory", async () => {
    const { repo, marker } = await fixture();
    const script = join(repo, "marker"); await executable(script, marker);
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, ".gitattributes"), "README.md diff=evil\n");
    await writeFile(join(repo, "README.md"), "changed\n");
    await runGit(repo, ["config", "diff.evil.textconv", script]);
    await expect(runGit(join(repo, "sub"), ["diff", "HEAD"])).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["uploadpack", "remote.origin.uploadpack"],
    ["receivepack", "remote.origin.receivepack"],
    ["Git proxy", "core.gitProxy"],
  ])("rejects executable remote transport configuration: %s", async (_label, key) => {
    const { repo, root, marker } = await fixture();
    const script = join(repo, "marker"); await executable(script, marker);
    await runGit(repo, ["config", key, script]);
    await expect(runGit(repo, ["ls-remote", "--heads", join(root, "missing-remote"), "main"])).rejects.toThrow("Git config is not allowed");
    await expect(runServerGitMutation(repo, ["push", join(root, "missing-remote"), "main:main"])).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("screens per-worktree config without following includes", async () => {
    const { root, repo, marker } = await fixture();
    const worktree = join(root, "worktree"); const script = join(repo, "marker"); await executable(script, marker);
    await runGit(repo, ["config", "extensions.worktreeConfig", "true"]);
    await runGit(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
    await runGit(worktree, ["config", "--worktree", "filter.evil.clean", script]);
    await expect(runGit(worktree, ["status", "--porcelain"])).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a config-free transport context instead of a URL-shaped remote alias", async () => {
    const { root, repo } = await fixture();
    const expected = join(root, "expected.git"); const redirected = join(root, "redirected.git");
    const branch = "multiagents/00000000-0000-4000-8000-000000000000";
    await runGit(root, ["init", "--bare", expected]);
    await runGit(root, ["init", "--bare", redirected]);
    const remoteUrl = `file://${expected}`;
    await runGit(repo, ["config", `remote.${remoteUrl}.url`, redirected]);
    expect(await lsRemoteTransport(remoteUrl, branch)).toBe("");
    const commit = await runGit(repo, ["rev-parse", "HEAD"]);
    await pushCommitTransport(repo, remoteUrl, commit, branch);
    expect(await runGit(root, ["--git-dir", expected, "rev-parse", `refs/heads/${branch}`])).toBe(commit);
    await expect(runGit(root, ["--git-dir", redirected, "rev-parse", `refs/heads/${branch}`])).rejects.toThrow();
  });

  it.each(["inside", "root", "symlink"])("ignores TMPDIR %s a malicious repository", async (location) => {
    const { root, repo, marker } = await fixture();
    const target = join(root, "target.git"); const redirected = join(root, "redirected.git"); const script = join(root, "marker");
    await runGit(root, ["init", "--bare", target]); await runGit(root, ["init", "--bare", redirected]); await executable(script, marker);
    const remoteUrl = `file://${target}`;
    await runGit(repo, ["config", `remote.${remoteUrl}.url`, redirected]);
    await writeFile(join(repo, ".git", "config"), `${await readFile(join(repo, ".git", "config"), "utf8")}\n[remote "${remoteUrl}"]\n\tuploadpack = ${script}\n\treceivepack = ${script}\n`);
    const tmpLink = join(root, "tmp-link"); if (location === "symlink") await (await import("node:fs/promises")).symlink(repo, tmpLink);
    const previous = process.env.TMPDIR; process.env.TMPDIR = location === "inside" ? join(repo, "nested") : location === "root" ? repo : tmpLink;
    try { expect(await lsRemoteTransport(remoteUrl, "main")).toBe(""); }
    finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a transport root nested inside a repository", async () => {
    const { repo } = await fixture();
    setGitTransportRootForTests(join(repo, "unsafe-transport"));
    await expect(lsRemoteTransport("file:///nonexistent", "main")).rejects.toThrow("must not be inside a repository");
  });

  it("rejects a transport root nested inside a bare repository before aliases or helpers run", async () => {
    const { root, repo, marker } = await fixture();
    const bare = join(root, "malicious.git"); const target = join(root, "target.git"); const redirected = join(root, "redirected.git");
    const script = join(root, "marker"); const remoteUrl = `file://${target}`;
    await runGit(root, ["init", "--bare", bare]); await runGit(root, ["init", "--bare", target]); await runGit(root, ["init", "--bare", redirected]); await executable(script, marker);
    const config = join(bare, "config");
    await writeFile(config, `${await readFile(config, "utf8")}\n[remote "${remoteUrl}"]\n\turl = ${redirected}\n\tuploadpack = ${script}\n\treceivepack = ${script}\n`);
    setGitTransportRootForTests(join(bare, "runtime", "git-transport"));
    await expect(lsRemoteTransport(remoteUrl, "main")).rejects.toThrow("must not be inside a repository");
    const commit = await runGit(repo, ["rev-parse", "HEAD"]);
    await expect(pushCommitTransport(repo, remoteUrl, commit, "multiagents/00000000-0000-4000-8000-000000000000")).rejects.toThrow("must not be inside a repository");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runGit(root, ["--git-dir", redirected, "rev-parse", "refs/heads/main"])).rejects.toThrow();
  });

  it("force-kills a TERM-resistant transport process after timeout and cleans its child directory", async () => {
    const { root } = await fixture();
    timeoutChild.enabled = true;
    setGitCommandTimeoutForTests(25);
    await expect(lsRemoteTransport("https://github.com/example/project.git", "main")).rejects.toThrow("git command timed out");
    expect(activeChildProcesses()).toEqual([]);
    expect(await readdir(join(root, "transport-runtime", "git-transport"))).toEqual([]);
  }, 15_000);

  it("ignores HOME and repository environment injection and cleans its transport child", async () => {
    const { root, repo } = await fixture();
    const target = join(root, "target.git"); const redirected = join(root, "redirected.git"); const home = join(root, "home");
    await runGit(root, ["init", "--bare", target]); await runGit(root, ["init", "--bare", redirected]); await mkdir(home);
    const remoteUrl = `file://${target}`;
    await writeFile(join(home, ".gitconfig"), `[remote "${remoteUrl}"]\n\turl = ${redirected}\n`);
    const previous = { HOME: process.env.HOME, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.HOME = home; process.env.GIT_DIR = join(repo, ".git"); process.env.GIT_WORK_TREE = repo;
    try { expect(await lsRemoteTransport(remoteUrl, "main")).toBe(""); }
    finally {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    expect(await readdir(join(root, "transport-runtime", "git-transport"))).toEqual([]);
  });

  it("bounds oversized Git stdout and stderr", async () => {
    const { repo } = await fixture();
    const head = await runGit(repo, ["rev-parse", "HEAD"]);
    const packedRefs = Array.from({ length: 40_000 }, (_, index) => `${head} refs/heads/flood/${index}\n`).join("");
    await writeFile(join(repo, ".git", "packed-refs"), packedRefs);
    await expect(runGit(repo, ["show-ref"])).rejects.toThrow("git output exceeded the security limit");
    const invalidRefs = Array.from({ length: 40_000 }, (_, index) => `${"0".repeat(40)} refs/heads/bad/${index}\n`).join("");
    await writeFile(join(repo, ".git", "packed-refs"), invalidRefs);
    await expect(runGit(repo, ["fsck", "--no-progress", "--no-reflogs"])).rejects.toThrow("git output exceeded the security limit");
  });

  it("does not consult URL-shaped remote uploadpack or receivepack settings", async () => {
    const { root, repo, marker } = await fixture();
    const target = join(root, "target.git"); const redirected = join(root, "redirected.git");
    const remoteUrl = `file://${target}`; const script = join(repo, "marker");
    await runGit(root, ["init", "--bare", target]); await runGit(root, ["init", "--bare", redirected]); await executable(script, marker);
    const commit = await runGit(repo, ["rev-parse", "HEAD"]);
    await runGit(repo, ["config", `remote.${remoteUrl}.url`, redirected]);
    const configPath = join(repo, ".git", "config");
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n[remote "${remoteUrl}"]\n\tuploadpack = ${script}\n\treceivepack = ${script}\n`);
    expect(await lsRemoteTransport(remoteUrl, "main")).toBe("");
    await expect(pushCommitTransport(repo, remoteUrl, commit, "multiagents/00000000-0000-4000-8000-000000000000")).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["textconv", "diff.evil.textconv", ["diff", "HEAD~1", "HEAD"]],
    ["receivepack", "remote.origin.receivepack", ["push", "origin", "HEAD:refs/heads/main"]],
    ["uploadpack", "remote.origin.uploadpack", ["ls-remote", "origin"]],
    ["URL rewrite", "url.file:///tmp/.insteadOf", ["rev-parse", "HEAD"]],
  ] as const)("screens bare repository %s configuration before Git executes it", async (_label, key, command) => {
    const { repo, marker } = await fixture();
    const script = join(repo, "marker"); await executable(script, marker);
    await writeFile(join(repo, ".gitattributes"), "README.md diff=evil\n");
    await runGit(repo, ["add", ".gitattributes"]); await runGit(repo, ["commit", "-m", "attributes"]);
    await writeFile(join(repo, "README.md"), "changed\n");
    await runGit(repo, ["add", "README.md"]); await runGit(repo, ["commit", "-m", "change"]);
    await runGit(repo, ["config", "core.bare", "true"]);
    await runGit(repo, ["config", key, script]);
    await expect(runGit(repo, command)).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("screens bare receivepack configuration before the server mutation helper", async () => {
    const { repo, marker } = await fixture();
    const script = join(repo, "marker"); await executable(script, marker);
    await runGit(repo, ["config", "core.bare", "true"]);
    await runGit(repo, ["config", "remote.origin.receivepack", script]);
    await expect(runServerGitMutation(repo, ["push", "file:///nonexistent", "HEAD:refs/heads/main"])).rejects.toThrow("Git config is not allowed");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
