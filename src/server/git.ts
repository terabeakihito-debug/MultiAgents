import { spawn } from "node:child_process";
import { buildChildProcessEnv, buildServerGitMutationEnv } from "./child-process-env";
import { redactKnownSecrets } from "./credential-resolver";

export const GIT_BINARY = "/usr/bin/git";
const MAX_GIT_OUTPUT = 2_000_000;

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const output = await runGitBytes(cwd, args);
  return redactKnownSecrets(output.toString("utf8")).trimEnd();
}

export async function runGitBytes(cwd: string, args: readonly string[], env = buildChildProcessEnv({ purpose: "git" })): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_BINARY, [...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(redactKnownSecrets(Buffer.concat(stderr).toString("utf8").trim()) || `git exited with code ${code}`));
      else if (oversized) reject(new Error("git output exceeded the security limit"));
      else resolve(Buffer.concat(stdout));
    });
  });
}

export async function serverGitMutationInvocation(cwd: string, args: readonly string[]) {
  const env = buildServerGitMutationEnv();
  const keys = (await runGitBytes(cwd, ["config", "--local", "--no-includes", "--name-only", "--list"], env)).toString("utf8").trimEnd()
    .split("\n").filter(Boolean);
  const unsafe = keys.find((key) => !isSafeLocalConfigKey(key));
  if (unsafe) throw new Error(`Repository Git config is not allowed for server mutation: ${unsafe}`);
  return {
    args: [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "core.attributesFile=/dev/null",
      "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false",
      "-c", "credential.helper=",
      "-c", "credential.helper=!/usr/bin/gh auth git-credential",
      "-c", "core.sshCommand=/usr/bin/ssh",
      "-c", "user.name=MultiAgents",
      "-c", "user.email=multiagents@localhost",
      ...args,
    ],
    env,
  };
}

function isSafeLocalConfigKey(key: string) {
  const normalized = key.toLowerCase();
  if ([
    "core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode", "core.symlinks",
    "extensions.worktreeconfig", "remote.origin.url", "remote.origin.fetch", "user.name", "user.email",
  ].includes(normalized)) return true;
  return /^branch\.[a-z0-9._\/-]+\.(?:remote|merge)$/i.test(key);
}
