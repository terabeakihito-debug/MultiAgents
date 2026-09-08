import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { AgentId } from "../agents/types";
import type { ProviderCredentialStatus, ProviderDiagnostic } from "../health/types";
import { classifyProviderVersion, parseProviderVersion, providerCompatibilityDefinitions } from "../providers/compatibility";
import { buildSandboxCommand } from "./os-sandbox";
import { registerChildProcess } from "./child-process-registry";
import { buildChildProcessEnv } from "./child-process-env";
import { getStateStore } from "./state-store";

const DIAGNOSTIC_TTL_MS = 24 * 60 * 60 * 1_000;
const OUTPUT_LIMIT = 32_000;
let cache: { expiresAt: number; value: ProviderDiagnostic[] } | undefined;
const credentialPaths: Record<AgentId, string> = { codex: join(homedir(), ".codex", "auth.json"), cursor: join(homedir(), ".config", "cursor", "auth.json"), claude: join(homedir(), ".claude", ".credentials.json") };

export async function providerDiagnostics(options: { cwd?: string; force?: boolean } = {}) {
  if (!options.force && cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await Promise.all((Object.keys(providerCompatibilityDefinitions) as AgentId[]).map(async (provider) => {
    try { return await diagnoseProvider(provider, { cwd: options.cwd }); } catch { return base(provider, "launch_failed"); }
  }));
  cache = { expiresAt: Date.now() + DIAGNOSTIC_TTL_MS, value };
  return value;
}

export async function diagnoseProvider(provider: AgentId, options: {
  cwd?: string; execute?: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  executableAvailable?: boolean; credentialAvailable?: boolean; credentialStatus?: ProviderCredentialStatus; identity?: string; persist?: boolean;
} = {}): Promise<ProviderDiagnostic> {
  const definition = providerCompatibilityDefinitions[provider];
  const executable = options.executableAvailable === undefined ? await providerExecutableIdentity(provider) : options.executableAvailable ? "test-executable" : undefined;
  if (!executable) return persist(base(provider, "missing"), options);
  const credentialStatus = options.credentialStatus ?? (options.credentialAvailable === undefined ? await credentialDiagnostic(provider) : options.credentialAvailable ? "available" : "missing");
  if (credentialStatus !== "available") return persist({ ...base(provider, "credential_unavailable"), credentialStatus }, options, options.identity ?? executable);
  // Cursor's bash/Node launcher suppresses version and help output when it is
  // attached to ordinary Node pipes. Use a fixed host pseudo-TTY for its
  // metadata only; the separate bwrap probe still verifies the real launcher.
  const execute = options.execute ?? ((args: string[]) => provider === "cursor" ? executeHostCursor(args) : executeInSandbox(provider, args, options.cwd ?? process.cwd()));
  let versionResult;
  try { versionResult = await execute(["--version"]); } catch { return persist({ ...base(provider, "version_probe_failed"), credentialStatus }, options, options.identity ?? executable); }
  if (versionResult.code !== 0) return persist({ ...base(provider, "version_probe_failed"), credentialStatus }, options, options.identity ?? executable);
  const parsed = parseProviderVersion(provider, `${versionResult.stdout}\n${versionResult.stderr}`);
  const version = parsed?.normalized;
  if (!parsed) return persist({ ...base(provider, "version_probe_failed"), version: safeVersion(versionResult), credentialStatus }, options, options.identity ?? executable);
  const versionStatus = classifyProviderVersion(provider, parsed);
  if (versionStatus === "unsupported_version") return persist({ ...base(provider, "unsupported_version"), version, credentialStatus, sandboxCompatible: true }, options, options.identity ?? executable);
  let help;
  try { help = await execute(provider === "codex" ? ["exec", "--help"] : ["--help"]); } catch { return persist({ ...base(provider, "sandbox_incompatible"), version, credentialStatus }, options, options.identity ?? executable); }
  if (help.code !== 0) return persist({ ...base(provider, "sandbox_incompatible"), version, credentialStatus }, options, options.identity ?? executable);
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (definition.requiredFlags.some((flag) => !containsFlag(helpText, flag))) return persist({ ...base(provider, "flag_incompatible"), version, credentialStatus, sandboxCompatible: true }, options, options.identity ?? executable);
  if (!options.execute && provider === "cursor") {
    try { const sandboxProbe = await executeInSandbox(provider, ["--version"], options.cwd ?? process.cwd()); if (sandboxProbe.code !== 0) return persist({ ...base(provider, "sandbox_incompatible"), version, credentialStatus }, options, options.identity ?? executable); }
    catch { return persist({ ...base(provider, "sandbox_incompatible"), version, credentialStatus }, options, options.identity ?? executable); }
  }
  return persist({ ...base(provider, versionStatus), version, credentialStatus, flagsCompatible: true, sandboxCompatible: true, launchCompatible: true }, options, options.identity ?? executable);
}

/** Called before every launcher use; stale or unsafe providers never receive a prompt. */
export async function assertProviderExecutionAllowed(provider: AgentId) {
  const diagnostic = (await providerDiagnostics()).find((item) => item.provider === provider);
  if (!diagnostic || !["supported", "supported_with_warning"].includes(diagnostic.status)) throw new ProviderCompatibilityError(provider, diagnostic?.status ?? "launch_failed");
  return diagnostic;
}
export class ProviderCompatibilityError extends Error { readonly provider: AgentId; readonly status: ProviderDiagnostic["status"]; constructor(provider: AgentId, status: ProviderDiagnostic["status"]) { super(`Provider ${provider} is not compatible (${status}). Agent execution is blocked until compatibility is reviewed.`); this.provider = provider; this.status = status; } }
export function acknowledgeProviderVersion(provider: AgentId, version: string) { if (!(provider in providerCompatibilityDefinitions) || !/^\d+(?:\.\d+){2}$/.test(version)) throw new Error("Invalid provider acknowledgement"); getStateStore().acknowledgeProviderCompatibility(provider, version); cache = undefined; }
export function resetProviderDiagnosticsForTests() { cache = undefined; }

async function persist(diagnostic: ProviderDiagnostic, options: Parameters<typeof diagnoseProvider>[1], identity?: string): Promise<ProviderDiagnostic> {
  if (options?.persist === false) return diagnostic;
  const store = getStateStore(); const previous = store.loadLatestProviderCompatibility(diagnostic.provider); const acknowledgedVersion = store.loadProviderCompatibilityAcknowledgement(diagnostic.provider);
  const versionChanged = Boolean(previous?.version && diagnostic.version && previous.version !== diagnostic.version); const identityChanged = Boolean(previous?.identity && identity && previous.identity !== identity);
  const value = { ...diagnostic, previousVersion: versionChanged ? previous!.version : undefined, versionChanged, identityChanged, acknowledgedVersion };
  store.saveProviderCompatibility({ ...value, identity }); return value;
}
function base(provider: AgentId, status: ProviderDiagnostic["status"]): ProviderDiagnostic { return { provider, status, flagsCompatible: false, credentialStatus: "missing", sandboxCompatible: false, launchCompatible: false, checkedAt: new Date().toISOString(), versionChanged: false, identityChanged: false }; }

async function executeInSandbox(provider: AgentId, args: string[], cwd: string) {
  const binary = provider === "claude" ? join(homedir(), ".local", "bin", "claude") : providerCompatibilityDefinitions[provider].binary;
  const command = buildSandboxCommand({ profile: "agent_read_only", provider, cwd, command: { binary, args } });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command.binary, command.args, { cwd: command.cwd, env: command.env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); const registration = registerChildProcess({ child, purpose: "other" }); let stdout = ""; let stderr = ""; let done = false;
    const timer = setTimeout(() => { if (!done) child.kill("SIGKILL"); }, 8_000); timer.unref(); child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.slice(0, OUTPUT_LIMIT - stdout.length); }); child.stderr.on("data", (chunk: string) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.slice(0, OUTPUT_LIMIT - stderr.length); });
    child.once("error", (error) => { done = true; clearTimeout(timer); registration.unregister(); reject(error); }); child.once("close", (code) => { done = true; clearTimeout(timer); registration.unregister(); resolve({ code, stdout, stderr }); });
  });
}
function executeHostCursor(args: string[]) {
  const binary = join(homedir(), ".local", "bin", "agent");
  const baseEnv = buildChildProcessEnv({ purpose: "agent", baseEnv: process.env });
  // Test runners commonly set NODE_ENV=test; Cursor suppresses normal CLI
  // output in that mode. Diagnostics must mirror the production launcher.
  const env = { ...baseEnv, NODE_ENV: baseEnv.NODE_ENV === "production" ? "production" : undefined } as NodeJS.ProcessEnv;
  const command = [shellQuote(binary), ...args.map(shellQuote)].join(" ");
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("/usr/bin/script", ["-qefc", command, "/dev/null"], { cwd: process.cwd(), env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); const registration = registerChildProcess({ child, purpose: "other" }); let stdout = ""; let stderr = ""; let done = false;
    const timer = setTimeout(() => { if (!done) child.kill("SIGKILL"); }, 8_000); timer.unref(); child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.slice(0, OUTPUT_LIMIT - stdout.length); }); child.stderr.on("data", (chunk: string) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.slice(0, OUTPUT_LIMIT - stderr.length); });
    child.once("error", (error) => { done = true; clearTimeout(timer); registration.unregister(); reject(error); }); child.once("close", (code) => { done = true; clearTimeout(timer); registration.unregister(); resolve({ code, stdout, stderr }); });
  });
}
function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function providerExecutableIdentity(provider: AgentId): Promise<string | undefined> {
  const binary = provider === "codex" ? join(dirname(dirname(process.execPath)), "lib", "node_modules", "@openai", "codex", "bin", "codex.js") : join(homedir(), ".local", "bin", provider === "cursor" ? "agent" : "claude");
  try { const resolved = await realpath(binary); if (!resolved.startsWith("/") || /^\/mnt\/[a-z](?:\/|$)/i.test(resolved) || /\.(?:exe|bat|cmd)$/i.test(resolved)) return undefined; const info = await stat(resolved); await access(resolved, constants.R_OK | constants.X_OK); return info.isFile() ? `${resolved}:${info.dev}:${info.ino}:${info.size}:${Math.trunc(info.mtimeMs)}` : undefined; } catch { return undefined; }
}
async function credentialDiagnostic(provider: AgentId): Promise<ProviderCredentialStatus> { try { const info = await lstat(credentialPaths[provider]); if (!info.isFile() || info.isSymbolicLink()) return "unsupported_layout"; return (info.mode & 0o077) === 0 ? "available" : "unsafe_permissions"; } catch { return "missing"; } }
function containsFlag(help: string, flag: string) { return new RegExp(`(?:^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,=])`, "m").test(help); }
function safeVersion(result: { stdout: string; stderr: string }) { return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120); }
