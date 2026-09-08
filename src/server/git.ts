import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { buildChildProcessEnv, buildServerGitMutationEnv } from "./child-process-env";
import { registerChildProcess } from "./child-process-registry";
import { redactKnownSecrets } from "./credential-resolver";

export const GIT_BINARY = "/usr/bin/git";
const MAX_GIT_OUTPUT = 2_000_000;
const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null",
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
  await rejectExecutableRepositoryConfig(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_BINARY, safeGitArgs(args), { cwd, env: safeGitEnv(env, options.allowServerIndexFile), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const registration = registerChildProcess({ child, purpose: "git" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let oversized = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_GIT_OUTPUT) stdout.push(chunk);
      else oversized = true;
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => { registration.unregister(); reject(error); });
    child.on("close", (code) => {
      registration.unregister();
      if (code !== 0) reject(new Error(redactKnownSecrets(Buffer.concat(stderr).toString("utf8").trim()) || `git exited with code ${code}`));
      else if (oversized) reject(new Error("git output exceeded the security limit"));
      else resolve(Buffer.concat(stdout));
    });
  });
}

export async function serverGitMutationInvocation(cwd: string, args: readonly string[]) {
  await rejectExecutableRepositoryConfig(cwd);
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

export function safeGitArgs(args: readonly string[]) {
  const noExternalDiff = args.includes("diff") ? ["--no-ext-diff"] : [];
  const separator = args.indexOf("--");
  const command = separator < 0 ? [...args, ...noExternalDiff] : [...args.slice(0, separator), ...noExternalDiff, ...args.slice(separator)];
  return ["--no-pager", ...SAFE_GIT_CONFIG, ...command];
}

function safeGitEnv(env: NodeJS.ProcessEnv, allowServerIndexFile = false): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || (!allowServerIndexFile && key === "GIT_INDEX_FILE") || key === "GIT_EXTERNAL_DIFF" || key.startsWith("GIT_CONFIG_")) delete safe[key];
  }
  safe.GIT_CONFIG_NOSYSTEM = "1";
  safe.GIT_CONFIG_SYSTEM = "/dev/null";
  safe.GIT_CONFIG_GLOBAL = "/dev/null";
  safe.GIT_NO_REPLACE_OBJECTS = "1";
  safe.GIT_PAGER = "cat";
  safe.PAGER = "cat";
  return safe;
}

/** Reads only regular Git config files; it never asks Git to interpret untrusted config. */
async function rejectExecutableRepositoryConfig(cwd: string) {
  const gitDir = await gitDirectory(cwd);
  if (!gitDir) return;
  const candidates = new Set([resolve(gitDir, "config"), resolve(gitDir, "config.worktree")]);
  if (resolve(/*turbopackIgnore: true*/ gitDir).includes("/worktrees/")) candidates.add(resolve(/*turbopackIgnore: true*/ gitDir, "../..", "config"));
  for (const path of candidates) {
    let info;
    try { info = await lstat(path); } catch (error) { if (isMissing(error)) continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Repository Git config must be a regular file");
    const unsafe = unsafeConfigKey(await readFile(path, "utf8"));
    if (unsafe) throw new Error(`Repository Git config is not allowed: ${unsafe}`);
  }
}

async function gitDirectory(cwd: string) {
  const dotGit = resolve(cwd, ".git");
  try {
    const info = await lstat(dotGit);
    if (info.isDirectory() && !info.isSymbolicLink()) return dotGit;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Repository Git directory is invalid");
    const value = await readFile(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/m.exec(value);
    if (!match || match[1].includes("\0")) throw new Error("Repository Git link is invalid");
    return isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(dotGit), match[1]);
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function unsafeConfigKey(contents: string) {
  let section = "";
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)]$/.exec(line);
    if (header) { section = header[1].trim().toLowerCase(); continue; }
    const name = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$)/.exec(line)?.[1]?.toLowerCase();
    if (!name) continue;
    const key = `${section}.${name}`;
    if (section === "include" || section.startsWith("includeif ") || section === "filter" || /^filter\s+/.test(section)) return key;
    if (key === "core.hookspath" || key === "core.fsmonitor") continue; // forced safe at command scope
    if (key === "diff.external" || /^diff\s+/.test(section) && ["command", "textconv", "trustexitcode"].includes(name)) return key;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
