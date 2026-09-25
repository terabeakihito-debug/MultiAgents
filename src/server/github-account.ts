import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAccountView, GitHubRemoteRepositoryView } from "../github/types";
import { buildChildProcessEnv } from "./child-process-env";
import { redactKnownSecrets } from "./credential-resolver";
import { GH_BINARY, runFixedProcess, type FixedProcessResult } from "./pull-request";
import { runGit } from "./git";
import { listRepositories, parseGitHubProjectUrl, validateRepository } from "./repositories";

export const GITHUB_HOSTNAME = "github.com" as const;
const GH_REPO_LIST_LIMIT = 100;
const GH_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TOKEN_LENGTH = 200;

export class GitHubConnectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConnectInputError";
  }
}

export class GitHubConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConnectError";
  }
}

type GhRunner = (args: readonly string[], cwd: string) => Promise<FixedProcessResult>;
type GhInputRunner = (args: readonly string[], cwd: string, input: string) => Promise<FixedProcessResult>;

let ghRunner: GhRunner = (args, cwd) =>
  runFixedProcess(GH_BINARY, args, cwd, GH_COMMAND_TIMEOUT_MS);
let ghInputRunner: GhInputRunner = (args, cwd, input) =>
  runGhWithStdin(args, cwd, input);

export function setGitHubAccountGhRunnerForTests(runner: GhRunner | null) {
  ghRunner = runner ?? ((args, cwd) => runFixedProcess(GH_BINARY, args, cwd, GH_COMMAND_TIMEOUT_MS));
}

export function setGitHubAccountGhInputRunnerForTests(runner: GhInputRunner | null) {
  ghInputRunner = runner ?? ((args, cwd, input) => runGhWithStdin(args, cwd, input));
}

async function ghCommandCwd() {
  return mkdtemp(join(tmpdir(), "multiagents-gh-"));
}

export function parseGhAuthLogin(stdout: string): string | undefined {
  const match = stdout.match(/Logged in to github\.com account (\S+)/i);
  return match?.[1];
}

export async function loadGitHubAccount(): Promise<GitHubAccountView> {
  const cwd = await ghCommandCwd();
  try {
    const result = await ghRunner(["auth", "status", "--hostname", GITHUB_HOSTNAME], cwd);
    const login = parseGhAuthLogin(`${result.stdout}\n${result.stderr}`);
    if (result.code === 0 && login) {
      return {
        connected: true,
        login,
        hostname: GITHUB_HOSTNAME,
        detail: "GitHub CLIの認証を確認しました",
      };
    }
    return {
      connected: false,
      hostname: GITHUB_HOSTNAME,
      detail: "GitHub CLIで github.com にログインしてください",
    };
  } catch {
    return {
      connected: false,
      hostname: GITHUB_HOSTNAME,
      detail: "GitHub CLIの認証を確認できません",
    };
  }
}

type GhRepoRow = {
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  description: string;
};

function parseGhRepoList(stdout: string): GhRepoRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("GitHub repository list response was invalid");
  }
  if (!Array.isArray(parsed)) throw new Error("GitHub repository list response was invalid");
  const rows: GhRepoRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.nameWithOwner !== "string" || typeof record.url !== "string") continue;
    if (typeof record.isPrivate !== "boolean" || typeof record.isFork !== "boolean") continue;
    const description = typeof record.description === "string" ? record.description : "";
    rows.push({
      nameWithOwner: record.nameWithOwner,
      url: record.url,
      isPrivate: record.isPrivate,
      isFork: record.isFork,
      description,
    });
  }
  return rows;
}

async function managedGitHubRepoNames(): Promise<Set<string>> {
  const managed = new Set<string>();
  const repos = await listRepositories();
  for (const repo of repos) {
    try {
      const validated = await validateRepository(repo.id);
      const { owner, repo: name } = parseGitHubProjectUrl(await runGit(validated.path, ["remote", "get-url", "origin"]));
      managed.add(`${owner}/${name}`.toLowerCase());
    } catch {
      /* local-only projects have no GitHub origin */
    }
  }
  return managed;
}

export async function listGitHubRemoteRepositories(): Promise<{ account: GitHubAccountView; repositories: GitHubRemoteRepositoryView[] }> {
  const account = await loadGitHubAccount();
  if (!account.connected) {
    return { account, repositories: [] };
  }

  const cwd = await ghCommandCwd();
  const result = await ghRunner([
    "repo", "list",
    "--limit", String(GH_REPO_LIST_LIMIT),
    "--hostname", GITHUB_HOSTNAME,
    "--json", "nameWithOwner,url,isPrivate,isFork,description",
  ], cwd);
  if (result.code !== 0) {
    throw new Error(redactKnownSecrets(result.stderr.trim() || "GitHub repository list failed"));
  }

  const managed = await managedGitHubRepoNames();
  const repositories = parseGhRepoList(result.stdout).map((row) => ({
    ...row,
    managedLocally: managed.has(row.nameWithOwner.toLowerCase()),
  }));
  return { account, repositories };
}

export async function connectGitHubWithToken(token: string): Promise<GitHubAccountView> {
  const normalized = token.trim();
  if (!normalized || normalized.length > MAX_TOKEN_LENGTH) {
    throw new GitHubConnectInputError("GitHub personal access token is required");
  }
  if (!/^[\x21-\x7E]+$/.test(normalized)) {
    throw new GitHubConnectInputError("Token format is not supported");
  }

  const cwd = await ghCommandCwd();
  const result = await ghInputRunner(
    ["auth", "login", "--hostname", GITHUB_HOSTNAME, "--with-token"],
    cwd,
    `${normalized}\n`,
  );
  if (result.code !== 0) {
    throw new GitHubConnectError(
      redactKnownSecrets(result.stderr.trim() || "GitHub authentication failed"),
    );
  }

  const account = await loadGitHubAccount();
  if (!account.connected) {
    throw new GitHubConnectError("GitHub authentication could not be verified");
  }
  return account;
}

async function runGhWithStdin(args: readonly string[], cwd: string, input: string): Promise<FixedProcessResult> {
  const env = buildChildProcessEnv({ purpose: "github" });
  return new Promise((resolve) => {
    const child = spawn(GH_BINARY, [...args], {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => {
      resolve({ stdout, stderr, code: 1, signal: null, timedOut: false, stdoutTruncated: false, stderrTruncated: false });
    });
    child.on("close", (code, signal) => {
      resolve({
        stdout,
        stderr,
        code,
        signal,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}
