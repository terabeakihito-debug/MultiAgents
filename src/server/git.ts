import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildChildProcessEnv, buildServerGitMutationEnv } from "./child-process-env";
import { registerChildProcess } from "./child-process-registry";
import { redactKnownSecrets } from "./credential-resolver";

export const GIT_BINARY = "/usr/bin/git";
const MAX_GIT_OUTPUT = 2_000_000;
const GIT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_TRANSPORT_ROOT = join(homedir(), ".multiagents", "runtime", "git-transport");
let transportRootForTests: string | undefined;
let gitCommandTimeoutForTests: number | undefined;
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.pager=cat",
  "-c", "pager.branch=false",
  "-c", "pager.diff=false",
  "-c", "diff.external=",
  "-c", "interactive.diffFilter=",
  "-c", "core.editor=true",
  "-c", "sequence.editor=true",
  "-c", "credential.helper=",
  "-c", "credential.helper=!/usr/bin/gh auth git-credential",
  "-c", "core.sshCommand=/usr/bin/ssh",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
] as const;

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const output = await runGitBytes(cwd, args);
  return redactKnownSecrets(output.toString("utf8")).trimEnd();
}

export async function runGitBytes(cwd: string, args: readonly string[], env = buildChildProcessEnv({ purpose: "git" }), options: { allowServerIndexFile?: boolean } = {}): Promise<Buffer> {
  const context = await resolveGitContext(cwd);
  if (context) await rejectExecutableRepositoryConfig(cwd, context);
  return executeGit(cwd, args, env, options);
}

function executeGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, options: { allowServerIndexFile?: boolean; configEnumeration?: boolean; discoveryCeiling?: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gitArgs = options.configEnumeration ? ["--no-pager", ...args] : safeGitArgs(args);
    const child = spawn(GIT_BINARY, gitArgs, { cwd, env: safeGitEnv(env, options.allowServerIndexFile, options.discoveryCeiling), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const registration = registerChildProcess({ child, purpose: "git" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let oversized = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // Do not leave an operation-owned Git process running after a timeout.
      // The registry performs group TERM, a fixed grace period, then group KILL.
      void registration.terminate().catch(() => undefined);
    }, gitCommandTimeoutForTests ?? GIT_COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBoundedOutput(stdout, stdoutSize, chunk);
      stdoutSize = appended.size; oversized ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBoundedOutput(stderr, stderrSize, chunk);
      stderrSize = appended.size; oversized ||= appended.truncated;
    });
    child.on("error", (error) => { clearTimeout(timeout); registration.unregister(); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      registration.unregister();
      if (timedOut) reject(new Error("git command timed out"));
      else if (oversized) reject(new Error("git output exceeded the security limit"));
      else if (code !== 0) reject(new Error(redactKnownSecrets(Buffer.concat(stderr).toString("utf8").trim()) || `git exited with code ${code}`));
      else resolve(Buffer.concat(stdout));
    });
  });
}

function appendBoundedOutput(target: Buffer[], currentSize: number, chunk: Buffer) {
  const remaining = MAX_GIT_OUTPUT - currentSize;
  if (remaining <= 0) return { size: currentSize, truncated: true };
  if (chunk.length <= remaining) { target.push(chunk); return { size: currentSize + chunk.length, truncated: false }; }
  target.push(chunk.subarray(0, remaining));
  return { size: MAX_GIT_OUTPUT, truncated: true };
}

export async function serverGitMutationInvocation(cwd: string, args: readonly string[]) {
  const context = await resolveGitContext(cwd);
  if (context) await rejectExecutableRepositoryConfig(cwd, context);
  const env = buildServerGitMutationEnv();
  return {
    args: safeGitArgs([
      "-c", "user.name=MultiAgents",
      "-c", "user.email=multiagents@localhost",
      ...args,
    ]),
    env,
  };
}

/**
 * Reads a validated remote from a server-owned, non-repository directory.
 * A URL-shaped remote name in the task repository therefore cannot be resolved
 * as an alias by Git.
 */
export async function lsRemoteTransport(remoteUrl: string, branch: string): Promise<string> {
  return withTransportDirectory(async (cwd) => {
    const output = await executeGit(cwd, ["ls-remote", "--heads", remoteUrl, branch], buildChildProcessEnv({ purpose: "git" }), { discoveryCeiling: cwd });
    return redactKnownSecrets(output.toString("utf8")).trimEnd();
  });
}

/**
 * Pushes one verified commit through a server-owned bare repository. Its config
 * contains no task-repository remotes; the task object database is only an
 * alternate object source, never a transport configuration source.
 */
export async function pushCommitTransport(cwd: string, remoteUrl: string, commitSha: string, destinationBranch: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw new Error("Invalid commit SHA for Git transport");
  if (!/^multiagents\/[0-9a-f-]{36}$/.test(destinationBranch)) throw new Error("Invalid destination branch for Git transport");
  const context = await resolveGitContext(cwd);
  if (!context) throw new Error("Git transport source is not a repository");
  await rejectExecutableRepositoryConfig(cwd, context);
  const objects = await realpath(join(context.commonDir, "objects"));
  await withTransportDirectory(async (transportRoot) => {
    const gitDir = join(transportRoot, "transport.git");
    await executeGit(transportRoot, ["init", "--bare", gitDir], buildChildProcessEnv({ purpose: "git" }), { discoveryCeiling: transportRoot });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
    const sourceRef = "refs/heads/multiagents-transport-source";
    await executeGit(transportRoot, [`--git-dir=${gitDir}`, "update-ref", sourceRef, commitSha], buildServerGitMutationEnv(), { discoveryCeiling: transportRoot });
    await executeGit(transportRoot, [`--git-dir=${gitDir}`, "push", remoteUrl, `${sourceRef}:refs/heads/${destinationBranch}`], buildServerGitMutationEnv(), { discoveryCeiling: transportRoot });
  });
}

async function withTransportDirectory<T>(operation: (cwd: string) => Promise<T>): Promise<T> {
  const root = await verifiedTransportRoot();
  const directory = await mkdtemp(join(root, "git-"));
  try { return await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Test-only override; production transport directories always use the server runtime root. */
export function setGitTransportRootForTests(root?: string) {
  transportRootForTests = root;
}

/** Test-only override for exercising the bounded timeout path. */
export function setGitCommandTimeoutForTests(timeoutMs?: number) {
  gitCommandTimeoutForTests = timeoutMs;
}

async function verifiedTransportRoot(): Promise<string> {
  const root = transportRootForTests ?? GIT_TRANSPORT_ROOT;
  if (!isAbsolute(root)) throw new Error("Git transport root must be absolute");
  await ensureSecureDirectoryHierarchy(root);
  const resolved = await realpath(/*turbopackIgnore: true*/ root);
  await assertNoGitRepositoryAncestor(resolved, transportBoundary(resolved));
  return resolved;
}

async function ensureSecureDirectoryHierarchy(path: string) {
  const resolved = resolve(path);
  const boundary = transportBoundary(resolved);
  await mkdir(boundary, { recursive: true, mode: 0o700 });
  let current = boundary;
  for (const part of resolved.slice(boundary.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Git transport root must contain only regular directories");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Git transport root must be owned by the server user");
    await chmod(current, 0o700);
  }
  const boundaryInfo = await lstat(boundary);
  if (!boundaryInfo.isDirectory() || boundaryInfo.isSymbolicLink()) throw new Error("Git transport root must contain only regular directories");
  if (typeof process.getuid === "function" && boundaryInfo.uid !== process.getuid()) throw new Error("Git transport root must be owned by the server user");
  await chmod(boundary, 0o700);
}

function transportBoundary(path: string) {
  return dirname(dirname(path));
}

async function assertNoGitRepositoryAncestor(path: string, boundary: string) {
  let current = path;
  while (true) {
    await assertNoGitMetadata(current);
    if (current === boundary) break;
    current = dirname(current);
  }
  // Git is the canonical parser for a complete bare repository. The command is
  // metadata-only and runs with the same isolated environment and fixed binary.
  try {
    const output = await executeGit(boundary, ["rev-parse", "--is-bare-repository", "--git-dir"], buildChildProcessEnv({ purpose: "git" }), { discoveryCeiling: dirname(boundary) });
    const [bare, gitDir, ...extra] = output.toString("utf8").trimEnd().split("\n");
    if (extra.length || !gitDir || (bare !== "true" && bare !== "false")) throw new Error("Git transport root repository metadata is ambiguous");
    throw new Error("Git transport root must not be inside a repository");
  } catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) return;
    throw error;
  }
}

async function assertNoGitMetadata(path: string) {
  for (const name of [".git", "HEAD", "objects", "refs", "config"]) {
    try {
      await lstat(join(/*turbopackIgnore: true*/ path, name));
      throw new Error("Git transport root must not be inside a repository");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export function safeGitArgs(args: readonly string[]) {
  const noExternalDiff = args.includes("diff") ? ["--no-ext-diff"] : [];
  const separator = args.indexOf("--");
  const command = separator < 0 ? [...args, ...noExternalDiff] : [...args.slice(0, separator), ...noExternalDiff, ...args.slice(separator)];
  return ["--no-pager", ...SAFE_GIT_CONFIG, ...command];
}

function safeGitEnv(env: NodeJS.ProcessEnv, allowServerIndexFile = false, discoveryCeiling?: string): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || (!allowServerIndexFile && key === "GIT_INDEX_FILE") || key === "GIT_EXTERNAL_DIFF" || key === "GIT_DIFF_OPTS" || key === "GIT_EDITOR" || key === "GIT_SEQUENCE_EDITOR" || key === "GIT_SSH" || key === "GIT_SSH_COMMAND" || key === "GIT_ASKPASS" || key === "SSH_ASKPASS" || key === "GIT_OBJECT_DIRECTORY" || key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" || key === "GIT_REPLACE_REF_BASE" || key === "GIT_NAMESPACE" || key === "GIT_CEILING_DIRECTORIES" || key.startsWith("GIT_CONFIG_")) delete safe[key];
  }
  safe.GIT_CONFIG_NOSYSTEM = "1";
  safe.GIT_CONFIG_SYSTEM = "/dev/null";
  safe.GIT_CONFIG_GLOBAL = "/dev/null";
  safe.GIT_NO_REPLACE_OBJECTS = "1";
  safe.GIT_PAGER = "cat";
  safe.PAGER = "cat";
  if (discoveryCeiling) safe.GIT_CEILING_DIRECTORIES = discoveryCeiling;
  return safe;
}

type GitContext =
  | { kind: "worktree"; root: string; gitDir: string; commonDir: string }
  | { kind: "bare"; gitDir: string; commonDir: string };

/** Resolves Git's own repository context using only a hardened metadata query. */
async function resolveGitContext(cwd: string): Promise<GitContext | undefined> {
  let output: Buffer;
  try {
    output = await executeGit(cwd, ["rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--git-dir", "--git-common-dir"], buildChildProcessEnv({ purpose: "git" }), {});
  } catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) return undefined;
    throw error;
  }
  const [insideWorkTree, bare, gitDir, commonDir, ...extra] = output.toString("utf8").trimEnd().split("\n");
  if (!gitDir || !commonDir || extra.length || (insideWorkTree !== "true" && insideWorkTree !== "false") || (bare !== "true" && bare !== "false")) throw new Error("Git repository metadata is invalid");
  const resolvedGitDir = await realpath(resolve(cwd, gitDir));
  const resolvedCommonDir = await realpath(resolve(cwd, commonDir));
  if (bare === "true") return { kind: "bare", gitDir: resolvedGitDir, commonDir: resolvedCommonDir };
  if (insideWorkTree !== "true") throw new Error("Git repository metadata is ambiguous");
  const root = await executeGit(cwd, ["rev-parse", "--show-toplevel"], buildChildProcessEnv({ purpose: "git" }), {});
  return { kind: "worktree", root: await realpath(root.toString("utf8").trim()), gitDir: resolvedGitDir, commonDir: resolvedCommonDir };
}

/** Git parses the exact resolved repository config; includes are deliberately not followed. */
async function rejectExecutableRepositoryConfig(cwd: string, context: GitContext) {
  const candidates = new Set([resolve(context.commonDir, "config"), resolve(context.commonDir, "config.worktree"), resolve(context.gitDir, "config"), resolve(context.gitDir, "config.worktree")]);
  for (const path of candidates) {
    let info;
    try { info = await lstat(path); } catch (error) { if (isMissing(error)) continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Repository Git config must be a regular file");
    await readFile(path, "utf8"); // Reject unreadable config before asking Git to enumerate it.
  }
  const names = (await executeGit(cwd, ["config", "--no-includes", "--null", "--name-only", "--list"], buildChildProcessEnv({ purpose: "git" }), { configEnumeration: true })).toString("utf8").split("\0").filter(Boolean);
  const unsafe = names.map((key) => key.toLowerCase()).find(isUnsafeConfigKey);
  if (unsafe) throw new Error(`Repository Git config is not allowed: ${unsafe}`);
}

function isUnsafeConfigKey(key: string) {
  if (key === "core.fsmonitor" || key === "core.hookspath") return false; // Forced safe at command scope.
  if (key === "core.attributesfile" || key === "core.excludesfile" || key === "core.sshcommand" || key === "core.gitproxy" || key === "core.pager" || key === "core.editor") return true;
  if (key.startsWith("include.") || key.startsWith("includeif.")) return true;
  if (key.startsWith("filter.")) return true;
  if (key === "diff.external" || /^diff\..+\.(command|textconv|trustexitcode)$/.test(key)) return true;
  if (key.startsWith("credential.") || key.startsWith("gpg.") || key === "commit.gpgsign" || key === "tag.gpgsign") return true;
  if (key.startsWith("pager.") || key === "interactive.difffilter" || key === "sequence.editor") return true;
  if (/^merge\..+\.driver$/.test(key) || key.startsWith("protocol.") || /^url\..+\.(insteadof|pushinsteadof)$/.test(key)) return true;
  if (/^remote\..+\.(uploadpack|receivepack|proxy|proxycommand)$/.test(key)) return true;
  return false;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
