import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentId } from "../agents/types";
import type { RuntimePolicy } from "../runtime/types";
import { registerChildProcess } from "./child-process-registry";
import type { ExecutableContentIdentity } from "./immutable-executable-binding";

export const BWRAP_BINARY = "/usr/bin/bwrap" as const;
export const SANDBOX_PROJECT_ROOT = "/project" as const;
export const SANDBOX_HOME = "/home/runtime" as const;
export const SANDBOX_PATH = "/opt/multiagents/node/bin:/usr/local/bin:/usr/bin:/bin" as const;

export type OsSandboxProfile = "agent_read_only" | "agent_implement" | "validation";
export type SandboxFailureCode =
  | "backend_missing"
  | "backend_not_executable"
  | "namespace_unsupported"
  | "invalid_sandbox_configuration"
  | "sandbox_launch_failed";

export type OsSandboxAudit = {
  type: "os_sandbox_created" | "os_sandbox_failed" | "os_sandbox_violation" | "os_sandbox_process_cleanup" | "os_sandbox_finalization_unconfirmed" | "os_sandbox_finalization_persistence_failed";
  profile: OsSandboxProfile;
  provider?: AgentId;
  capabilityClass: string;
  failureCode?: SandboxFailureCode;
};

export type PublicOsSandboxPolicy = {
  status: "enforced";
  profile: OsSandboxProfile;
  filesystem: "isolated";
  home: "private";
  proc: "private";
  tmp: "private";
  wslInterop: "blocked";
  windowsMounts: "blocked";
  path: "linux_only";
  writeScope: "task_worktree_only" | "denied";
  validationNetwork: "blocked";
  agentNetwork: "limited_provider_required";
  credentials: "provider_minimal_read_only" | "none";
};

export type SandboxCommand = {
  binary: typeof BWRAP_BINARY;
  args: string[];
  cwd: "/";
  env: NodeJS.ProcessEnv;
  sandboxCwd: typeof SANDBOX_PROJECT_ROOT;
};

export class OsSandboxUnavailableError extends Error {
  constructor(public readonly failureCode: SandboxFailureCode, detail?: string) {
    super(`OS sandbox unavailable. Task execution blocked.${detail ? ` ${detail}` : ""}`);
    this.name = "OsSandboxUnavailableError";
  }
}

export function sandboxProfileForRuntimePolicy(policy: RuntimePolicy): OsSandboxProfile {
  return policy.allowWrite ? "agent_implement" : "agent_read_only";
}

export function publicOsSandboxPolicy(profile: OsSandboxProfile): PublicOsSandboxPolicy {
  return {
    status: "enforced",
    profile,
    filesystem: "isolated",
    home: "private",
    proc: "private",
    tmp: "private",
    wslInterop: "blocked",
    windowsMounts: "blocked",
    path: "linux_only",
    writeScope: profile === "agent_read_only" ? "denied" : "task_worktree_only",
    validationNetwork: "blocked",
    agentNetwork: "limited_provider_required",
    credentials: profile === "validation" ? "none" : "provider_minimal_read_only",
  };
}

export function buildSandboxCommand(input: {
  profile: OsSandboxProfile;
  cwd: string;
  writableRoot?: string;
  baseRepoRoot?: string;
  provider?: AgentId;
  command: { binary: string; args: readonly string[] };
  env?: Readonly<Record<string, string | undefined>>;
  /** Fixed Cursor metadata probe: pseudo-TTY inside the sandbox PID namespace. */
  pseudoTty?: boolean;
  codexRuntime?: StagedCodexRuntimeBinding;
  cursorRuntime?: StagedCursorRuntimeBinding;
  claudeRuntime?: StagedClaudeRuntimeBinding;
}): SandboxCommand {
  const cwd = requireAbsoluteSafePath(input.cwd, "sandbox cwd");
  if (input.profile === "agent_implement") {
    if (!input.writableRoot || resolve(input.writableRoot) !== cwd) invalid("Implement sandbox requires the task worktree as its only writable root");
    if (!input.baseRepoRoot || resolve(input.baseRepoRoot) === cwd) invalid("Implement sandbox requires a distinct read-only base repository");
  } else if (input.writableRoot) {
    invalid("Read-only and validation sandbox profiles cannot accept an extra writable root");
  }
  if (input.profile === "validation" && input.provider) invalid("Validation cannot mount an Agent credential set");
  if (input.profile !== "validation" && !input.provider) invalid("Agent sandbox requires a fixed provider");
  if (input.pseudoTty && input.provider !== "cursor") invalid("Pseudo-TTY is restricted to the fixed Cursor diagnostic launcher");

  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(input.profile === "validation" || input.pseudoTty ? ["--unshare-net"] : []),
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--dir", "/run",
    "--dir", "/home",
    "--dir", SANDBOX_HOME,
    "--dir", "/opt",
    "--dir", "/opt/multiagents",
  ];

  addOptionalSystemFiles(args);
  const mappedCommand = input.provider
    ? addProviderRuntime(args, input.provider, input.command, { codex: input.codexRuntime, cursor: input.cursorRuntime, claude: input.claudeRuntime })
    : addValidationRuntime(args, input.command);

  if (input.profile === "agent_implement") {
    const baseRepo = requireAbsoluteSafePath(input.baseRepoRoot!, "base repository");
    const homeChild = firstHomeChild(baseRepo);
    if (homeChild) args.push("--tmpfs", homeChild);
    addParentDirectories(args, baseRepo);
    args.push("--ro-bind", baseRepo, baseRepo);
    if (homeChild) args.push("--remount-ro", homeChild);
    args.push("--bind", cwd, SANDBOX_PROJECT_ROOT);
  } else if (input.profile === "validation") {
    // Validation scripts may write build/test artifacts, but nothing outside the task worktree.
    args.push("--bind", cwd, SANDBOX_PROJECT_ROOT);
  } else {
    args.push("--ro-bind", cwd, SANDBOX_PROJECT_ROOT);
  }
  const gitLink = join(cwd, ".git");
  if (input.profile !== "agent_read_only" && isRegularKnown(gitLink)) args.push("--ro-bind", gitLink, `${SANDBOX_PROJECT_ROOT}/.git`);

  const innerEnv = sandboxEnvironment(input.profile, input.provider, input.env);
  for (const [name, value] of Object.entries(innerEnv)) args.push("--setenv", name, value);
  const executable = input.pseudoTty ? "/usr/bin/script" : mappedCommand.binary;
  const executableArgs = input.pseudoTty ? ["-qefc", shellCommand(mappedCommand.binary, mappedCommand.args), "/dev/null"] : mappedCommand.args;
  args.push("--chdir", SANDBOX_PROJECT_ROOT, "--", executable, ...executableArgs);

  return {
    binary: BWRAP_BINARY,
    args,
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: innerEnv.LANG, LC_ALL: innerEnv.LC_ALL, NODE_ENV: safeNodeEnv(process.env.NODE_ENV) },
    sandboxCwd: SANDBOX_PROJECT_ROOT,
  };
}

export async function checkOsSandboxAvailability(backendPath: string = BWRAP_BINARY): Promise<{ available: true; backend: "bubblewrap"; version: 1 }> {
  if (backendPath !== BWRAP_BINARY) throw new OsSandboxUnavailableError("backend_missing");
  try { await access(backendPath, constants.F_OK); }
  catch { throw new OsSandboxUnavailableError("backend_missing"); }
  try { await access(backendPath, constants.X_OK); }
  catch { throw new OsSandboxUnavailableError("backend_not_executable"); }

  const result = await runProbe(backendPath);
  if (result.code !== 0 || result.stdout.trim() !== "SANDBOX_OK") {
    throw new OsSandboxUnavailableError("namespace_unsupported");
  }
  return { available: true, backend: "bubblewrap", version: 1 };
}

let availability: Promise<{ available: true; backend: "bubblewrap"; version: 1 }> | undefined;
export function assertOsSandboxAvailable() {
  availability ??= checkOsSandboxAvailability();
  return availability;
}

export function resetOsSandboxAvailabilityForTests() { availability = undefined; }

function runProbe(binary: string) {
  return new Promise<{ code: number | null; stdout: string }>((resolveProbe, rejectProbe) => {
    const child = spawn(binary, [
      "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/home", "--dir", SANDBOX_HOME,
      "--setenv", "HOME", SANDBOX_HOME, "--setenv", "PATH", "/usr/bin:/bin",
      "--", "/bin/sh", "-c",
      "test ! -e /home/justa && test ! -e /mnt/c && test ! -e /init && test -z \"$WSL_INTEROP\" && printf SANDBOX_OK",
    ], { cwd: "/", env: { PATH: "/usr/bin:/bin", NODE_ENV: safeNodeEnv(process.env.NODE_ENV) }, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
    const registration = registerChildProcess({ child, purpose: "other" });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { if (stdout.length < 100) stdout += value; });
    child.once("error", (error) => { registration.unregister(); rejectProbe(error); });
    child.once("close", (code) => { registration.unregister(); resolveProbe({ code, stdout }); });
  }).catch((error: unknown) => {
    if (error instanceof OsSandboxUnavailableError) throw error;
    throw new OsSandboxUnavailableError("namespace_unsupported");
  });
}

function addProviderRuntime(args: string[], provider: AgentId, command: { binary: string; args: readonly string[] }, runtimes: { codex?: StagedCodexRuntimeBinding; cursor?: StagedCursorRuntimeBinding; claude?: StagedClaudeRuntimeBinding }) {
  const hostHome = homedir();
  if (provider === "codex") {
    if (command.binary !== "codex") invalid("Codex provider command is not fixed");
    if (!runtimes.codex) invalid("Codex sandbox requires a fresh runtime binding");
    const runtime = runtimes.codex;
    if (!runtime.stagedExecutable.startsWith("/")) invalid("Codex immutable runtime binding is invalid");
    args.push("--dir", "/opt/multiagents/codex", "--ro-bind", runtime.stagedExecutable, "/opt/multiagents/codex/codex");
    addCredentialFile(args, join(hostHome, ".codex", "auth.json"), join(SANDBOX_HOME, ".codex", "auth.json"));
    return { binary: "/opt/multiagents/codex/codex", args: [...command.args] };
  }
  if (provider === "cursor") {
    if (command.binary !== "agent") invalid("Cursor provider command is not fixed");
    if (!runtimes.cursor?.stagedRuntimeRoot.startsWith("/")) invalid("Cursor sandbox requires an immutable runtime binding");
    args.push("--ro-bind", runtimes.cursor.stagedRuntimeRoot, "/opt/multiagents/cursor");
    addCredentialFile(args, join(hostHome, ".config", "cursor", "auth.json"), join(SANDBOX_HOME, ".config", "cursor", "auth.json"));
    return { binary: "/opt/multiagents/cursor/cursor-agent", args: [...command.args] };
  }
  const expected = join(hostHome, ".local", "bin", "claude");
  if (command.binary !== expected) invalid("Claude provider command is not fixed");
  if (!runtimes.claude?.stagedExecutable.startsWith("/")) invalid("Claude sandbox requires an immutable runtime binding");
  args.push("--ro-bind", runtimes.claude.stagedExecutable, "/opt/multiagents/claude");
  addCredentialFile(args, join(hostHome, ".claude", ".credentials.json"), join(SANDBOX_HOME, ".claude", ".credentials.json"));
  return { binary: "/opt/multiagents/claude", args: [...command.args] };
}

export type CodexRuntimeResolution = { source: "optional" | "vendor"; mainPackageRoot: string; installRoot: string; packageRoot: string; packageJson: string; nativeExecutable: string; optionalPackageName: string };
export type CodexRuntimeBinding = CodexRuntimeResolution & { nativeIdentity: ExecutableContentIdentity };
export type StagedCodexRuntimeBinding = CodexRuntimeBinding & { stagedExecutable: string; stagedDigest: string };
export type StagedCursorRuntimeBinding = { stagedRuntimeRoot: string; aggregateDigest: string };
export type StagedClaudeRuntimeBinding = { stagedExecutable: string; digest: string };

function addValidationRuntime(args: string[], command: { binary: string; args: readonly string[] }) {
  const binary = requireAbsoluteSafePath(command.binary, "validation executable");
  const nodeRoot = nodeInstallationRoot();
  addNodeRuntime(args, true);
  const mappedArgs = command.args.map((arg) => mapNodeRuntimePath(arg, nodeRoot));
  const rel = relative(nodeRoot, binary);
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`)) return { binary: join("/opt/multiagents/node", rel), args: mappedArgs };
  if (binary === "/bin/sh" || binary === "/bin/bash" || binary.startsWith("/usr/bin/")) return { binary, args: mappedArgs };
  invalid("Validation executable is outside the fixed Linux runtime");
}

function mapNodeRuntimePath(value: string, nodeRoot: string) {
  if (!isAbsolute(value)) return value;
  const rel = relative(nodeRoot, value);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? join("/opt/multiagents/node", rel) : value;
}

function addNodeRuntime(args: string[], includeNpm: boolean) {
  const nodeRoot = nodeInstallationRoot();
  args.push(
    "--dir", "/opt/multiagents/node",
    "--dir", "/opt/multiagents/node/bin",
    "--ro-bind", process.execPath, "/opt/multiagents/node/bin/node",
  );
  if (!includeNpm) return;
  const npmRoot = join(nodeRoot, "lib", "node_modules", "npm");
  args.push(
    "--dir", "/opt/multiagents/node/lib",
    "--dir", "/opt/multiagents/node/lib/node_modules",
    "--ro-bind", npmRoot, "/opt/multiagents/node/lib/node_modules/npm",
    "--symlink", "../lib/node_modules/npm/bin/npm-cli.js", "/opt/multiagents/node/bin/npm",
    "--symlink", "../lib/node_modules/npm/bin/npx-cli.js", "/opt/multiagents/node/bin/npx",
  );
}

function sandboxEnvironment(profile: OsSandboxProfile, provider: AgentId | undefined, source: Readonly<Record<string, string | undefined>> = process.env) {
  const env: Record<string, string> = {
    HOME: SANDBOX_HOME,
    PATH: SANDBOX_PATH,
    TMPDIR: "/tmp",
    LANG: safeLocale(source.LANG),
    LC_ALL: safeLocale(source.LC_ALL),
    TERM: safeTerm(source.TERM),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (source.NODE_ENV === "production") env.NODE_ENV = "production";
  if (provider === "codex") env.CODEX_HOME = `${SANDBOX_HOME}/.codex`;
  if (provider === "claude") env.CLAUDE_CONFIG_DIR = `${SANDBOX_HOME}/.claude`;
  if (provider === "cursor") {
    env.XDG_CONFIG_HOME = `${SANDBOX_HOME}/.config`;
    env.XDG_CACHE_HOME = `${SANDBOX_HOME}/.cache`;
    env.CURSOR_CONFIG_DIR = `${SANDBOX_HOME}/.cursor`;
    env.AGENT_CLI_CREDENTIAL_STORE = "file";
  }
  if (profile === "validation") env.NO_UPDATE_NOTIFIER = "1";
  return env;
}

function addOptionalSystemFiles(args: string[]) {
  args.push("--dir", "/etc");
  for (const path of [
    "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/ssl", "/etc/ca-certificates",
  ]) {
    if (existsKnown(path)) args.push("--ro-bind", path, path);
  }
  // /usr is required for the Linux toolchain; mask gh so Agent/validation cannot execute server GitHub mutations.
  for (const executable of ["/usr/bin/gh", "/usr/bin/cmd.exe", "/usr/bin/powershell", "/usr/bin/powershell.exe", "/usr/bin/pwsh", "/usr/bin/pwsh.exe"]) {
    if (existsKnown(executable)) args.push("--ro-bind", "/bin/false", executable);
  }
}

function addCredentialFile(args: string[], source: string, destination: string) {
  if (!isRegularKnown(source)) return;
  addParentDirectories(args, destination);
  args.push("--ro-bind", source, destination);
}

function addParentDirectories(args: string[], path: string) {
  const parts = dirname(path).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (["/usr", "/bin", "/lib", "/lib64", "/dev", "/proc", "/tmp", "/run", "/home", SANDBOX_HOME, "/opt", "/opt/multiagents"].includes(current)) continue;
    args.push("--dir", current);
  }
}

function firstHomeChild(path: string) {
  const match = resolve(path).match(/^\/home\/[^/]+/);
  return match?.[0];
}

function nodeInstallationRoot() { return dirname(dirname(process.execPath)); }
function existsKnown(path: string) { try { accessSync(path, constants.F_OK); return true; } catch { return false; } }
function isRegularKnown(path: string) { try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink(); } catch { return false; } }
function requireAbsoluteSafePath(path: string, label: string) {
  if (!isAbsolute(path) || path.includes("\0") || /^\/mnt\/[a-z](?:\/|$)/i.test(path)) invalid(`${label} is invalid`);
  const normalized = resolve(path);
  if (["/", "/home", homedir(), "/tmp"].includes(normalized)) invalid(`${label} is too broad`);
  return normalized;
}
function safeLocale(value: string | undefined) { return value && /^[A-Za-z0-9_.@-]{1,64}$/.test(value) ? value : "C.UTF-8"; }
function safeTerm(value: string | undefined) { return value && /^[A-Za-z0-9_.+-]{1,64}$/.test(value) ? value : "xterm-256color"; }
function shellCommand(binary: string, args: readonly string[]) { return [binary, ...args].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "); }
function safeNodeEnv(value: string | undefined): "development" | "production" | "test" { return value === "production" || value === "test" ? value : "development"; }
function invalid(message: string): never { throw new OsSandboxUnavailableError("invalid_sandbox_configuration", message); }
