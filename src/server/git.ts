import { spawn } from "node:child_process";
import { buildChildProcessEnv } from "./child-process-env";
import { redactKnownSecrets } from "./credential-resolver";

export const GIT_BINARY = "/usr/bin/git";
const MAX_GIT_OUTPUT = 2_000_000;

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_BINARY, [...args], { cwd, env: buildChildProcessEnv({ purpose: "git" }), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => { if (size < MAX_GIT_OUTPUT) { stdout.push(chunk); size += chunk.length; } });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(redactKnownSecrets(Buffer.concat(stdout).subarray(0, MAX_GIT_OUTPUT).toString("utf8")).trimEnd())
      : reject(new Error(redactKnownSecrets(Buffer.concat(stderr).toString("utf8").trim()) || `git exited with code ${code}`)));
  });
}
