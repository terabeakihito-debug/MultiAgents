import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { AgentId } from "../agents/types";
import type { ProviderDiagnostic } from "../health/types";
import { buildSandboxCommand } from "./os-sandbox";
import { registerChildProcess } from "./child-process-registry";

const manifests: Record<AgentId, {
  binary: string; credential: string; versionPattern: RegExp; helpArgs: string[]; requiredFlags: string[];
}> = {
  codex: {
    binary: "codex", credential: join(homedir(), ".codex", "auth.json"), versionPattern: /^codex-cli 0\.(?:15[0-9]|1[6-9][0-9]|[2-9][0-9]{2})\./,
    helpArgs: ["exec", "--help"], requiredFlags: ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "--cd"],
  },
  cursor: {
    binary: "agent", credential: join(homedir(), ".config", "cursor", "auth.json"), versionPattern: /^20(?:26|27)\./,
    helpArgs: ["--help"], requiredFlags: ["--trust", "--workspace", "--skip-worktree-setup", "--mode", "--sandbox", "--print"],
  },
  claude: {
    binary: join(homedir(), ".local", "bin", "claude"), credential: join(homedir(), ".claude", ".credentials.json"), versionPattern: /^2\./,
    helpArgs: ["--help"], requiredFlags: ["--restricted", "--safe-mode", "--strict-mcp-config", "--permission-mode", "--permission-prompts", "--tools", "--print"],
  },
};

let cache: { expiresAt: number; value: ProviderDiagnostic[] } | undefined;

export async function providerDiagnostics(options: { cwd?: string; force?: boolean } = {}) {
  if (!options.force && cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await Promise.all((Object.keys(manifests) as AgentId[]).map((provider) => diagnoseProvider(provider, { cwd: options.cwd })));
  cache = { expiresAt: Date.now() + 5 * 60_000, value };
  return value;
}

export async function diagnoseProvider(provider: AgentId, options: {
  cwd?: string;
  execute?: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  executableAvailable?: boolean;
  credentialAvailable?: boolean;
} = {}): Promise<ProviderDiagnostic> {
  const manifest = manifests[provider];
  const executable = options.executableAvailable ?? await providerExecutableAvailable(provider);
  if (!executable) return { provider, status: "missing" };
  const credential = options.credentialAvailable ?? await regularReadableFile(manifest.credential);
  if (!credential) return { provider, status: "credential_unavailable" };
  const execute = options.execute ?? ((args: string[]) => executeInSandbox(provider, manifest.binary, args, options.cwd ?? process.cwd()));
  let versionResult;
  try { versionResult = await execute(["--version"]); }
  catch { return { provider, status: "sandbox_incompatible" }; }
  if (versionResult.code !== 0) return { provider, status: "sandbox_incompatible" };
  const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim().split("\n").find(Boolean)?.slice(0, 120);
  if (!version || !manifest.versionPattern.test(version)) return { provider, status: "unsupported_version", version };
  let help;
  try { help = await execute(manifest.helpArgs); }
  catch { return { provider, status: "sandbox_incompatible", version }; }
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (help.code !== 0) return { provider, status: "sandbox_incompatible", version };
  if (manifest.requiredFlags.some((flag) => !helpText.includes(flag))) return { provider, status: "unsupported_version", version };
  return { provider, status: "supported", version };
}

export function resetProviderDiagnosticsForTests() { cache = undefined; }

async function executeInSandbox(provider: AgentId, binary: string, args: string[], cwd: string) {
  const command = buildSandboxCommand({ profile: "agent_read_only", provider, cwd, command: { binary, args } });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command.binary, command.args, { cwd: command.cwd, env: command.env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const registration = registerChildProcess({ child, purpose: "other" });
    let stdout = ""; let stderr = ""; let done = false;
    const timer = setTimeout(() => { if (!done) child.kill("SIGKILL"); }, 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 200_000) stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 200_000) stderr += chunk; });
    child.once("error", (error) => { done = true; clearTimeout(timer); registration.unregister(); reject(error); });
    child.once("close", (code) => { done = true; clearTimeout(timer); registration.unregister(); resolve({ code, stdout, stderr }); });
  });
}

async function providerExecutableAvailable(provider: AgentId) {
  if (provider === "codex") return regularReadableFile(join(dirname(dirname(process.execPath)), "lib", "node_modules", "@openai", "codex", "bin", "codex.js"));
  return regularReadableFile(join(homedir(), ".local", "bin", provider === "cursor" ? "agent" : "claude"), true);
}

async function regularReadableFile(path: string, allowSymlink = false) {
  try {
    const info = await lstat(path);
    if (!(info.isFile() || (allowSymlink && info.isSymbolicLink()))) return false;
    await access(path, constants.R_OK);
    return true;
  } catch { return false; }
}
