import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import type { AgentId } from "../agents/types";
import type { ProviderCredentialStatus, ProviderDiagnostic } from "../health/types";
import { classifyProviderVersion, parseProviderVersion, providerCompatibilityDefinitions } from "../providers/compatibility";
import { buildSandboxCommand, type CodexRuntimeBinding, type CodexRuntimeResolution, type StagedClaudeRuntimeBinding, type StagedCodexRuntimeBinding, type StagedCursorRuntimeBinding } from "./os-sandbox";
import { aggregateRuntimeArtifactIdentity, executableContentIdentity, prepareImmutableExecutableBinding, prepareImmutableRuntimeBinding, type ExecutableContentIdentity, type RuntimeArtifact } from "./immutable-executable-binding";
import { buildChildProcessEnv } from "./child-process-env";
import { getStateStore } from "./state-store";
import { runHardenedProcess } from "./pull-request";

const DIAGNOSTIC_TTL_MS = 24 * 60 * 60 * 1_000;
const PARSER_AND_SANDBOX_POLICY_VERSION = "provider-parser-sandbox-21c8-cursor-runtime-manifest";
const CODEX_RUNTIME_RESOLVER = join(process.cwd(), "src", "server", "codex-runtime-resolver.mjs");
const CODEX_RUNTIME_RESOLUTION_TIMEOUT_MS = 2_000;
export const PROVIDER_COMPATIBILITY_POLICY_VERSION = createHash("sha256")
  .update(JSON.stringify({ definitions: providerCompatibilityDefinitions, parserAndSandbox: PARSER_AND_SANDBOX_POLICY_VERSION }))
  .digest("hex").slice(0, 24);
export const MAX_IDENTITY_DIAGNOSTIC_RETRIES = 1;
let cache: { expiresAt: number; value: ProviderDiagnostic[] } | undefined;
const credentialPaths: Record<AgentId, string> = { codex: join(homedir(), ".codex", "auth.json"), cursor: join(homedir(), ".config", "cursor", "auth.json"), claude: join(homedir(), ".claude", ".credentials.json") };
type IdentityContext = { home: string; nodePath: string; nodeRoot: string };
export type CursorRuntimeManifestArtifact = Pick<RuntimeArtifact, "name" | "identity" | "executable">;
export type CursorRuntimeManifest = { runtimeRoot: string; artifacts: readonly CursorRuntimeManifestArtifact[]; aggregateDigest: string; sourceSecurityDigest: string };
type CursorRuntimeBinding = CursorRuntimeManifest;
type ClaudeRuntimeBinding = { executable: string; identity: ExecutableContentIdentity };
type ProviderIdentityCapture = { identity: string; codexRuntime?: CodexRuntimeBinding; cursorRuntime?: CursorRuntimeBinding; claudeRuntime?: ClaudeRuntimeBinding };
function currentIdentityContext(): IdentityContext { return { home: homedir(), nodePath: process.execPath, nodeRoot: dirname(dirname(process.execPath)) }; }

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
  const capture = options.identity === undefined && options.executableAvailable === undefined ? await captureProviderExecutionIdentity(provider) : undefined;
  const identity = options.identity ?? capture?.identity ?? executable;
  if (credentialStatus !== "available") return persist({ ...base(provider, "credential_unavailable"), credentialStatus }, options, identity);
  // Cursor's bash/Node launcher suppresses version and help output when it is
  // attached to ordinary Node pipes. Use a fixed host pseudo-TTY for its
  // metadata only; the separate bwrap probe still verifies the real launcher.
  const execute = options.execute ?? ((args: string[]) => executeInSandbox(provider, args, options.cwd ?? process.cwd(), capture));
  let versionResult;
  try { versionResult = await execute(["--version"]); } catch (error) { return persist({ ...base(provider, error instanceof ProviderDiagnosticTimeoutError ? "launch_failed" : "version_probe_failed"), credentialStatus }, options, identity); }
  if (versionResult.code !== 0) return persist({ ...base(provider, "version_probe_failed"), credentialStatus }, options, identity);
  const parsed = parseProviderVersion(provider, `${versionResult.stdout}\n${versionResult.stderr}`);
  const version = parsed?.normalized;
  if (!parsed) return persist({ ...base(provider, "version_probe_failed"), version: safeVersion(versionResult), credentialStatus }, options, identity);
  const versionStatus = classifyProviderVersion(provider, parsed);
  if (versionStatus === "unsupported_version") return persist({ ...base(provider, "unsupported_version"), version, credentialStatus, sandboxCompatible: true }, options, identity);
  let help;
  try { help = await execute(provider === "codex" ? ["exec", "--help"] : ["--help"]); } catch (error) { return persist({ ...base(provider, error instanceof ProviderDiagnosticTimeoutError ? "launch_failed" : "sandbox_incompatible"), version, credentialStatus }, options, identity); }
  if (help.code !== 0) return persist({ ...base(provider, "sandbox_incompatible"), version, credentialStatus }, options, identity);
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (definition.requiredFlags.some((flag) => !containsFlag(helpText, flag))) return persist({ ...base(provider, "flag_incompatible"), version, credentialStatus, sandboxCompatible: true }, options, identity);
  if (!options.execute && provider === "cursor") {
    try { const sandboxProbe = await executeInSandbox(provider, ["--version"], options.cwd ?? process.cwd(), capture); if (sandboxProbe.code !== 0) return persist({ ...base(provider, "sandbox_incompatible"), version, credentialStatus }, options, identity); }
    catch { return persist({ ...base(provider, "sandbox_incompatible"), version, credentialStatus }, options, identity); }
  }
  return persist({ ...base(provider, versionStatus), version, credentialStatus, flagsCompatible: true, sandboxCompatible: true, launchCompatible: true }, options, identity);
}

/** Called before every launcher use; stale or unsafe providers never receive a prompt. */
export async function assertProviderExecutionAllowed(provider: AgentId) {
  let diagnostic = (await providerDiagnostics()).find((item) => item.provider === provider);
  if (diagnostic?.identity === (await captureProviderExecutionIdentity(provider)).identity && supported(diagnostic)) return diagnostic;
  // A diagnostic result is accepted only when the identity sampled before its
  // probes still describes the launcher chain after those probes complete.
  for (let attempt = 0; attempt <= MAX_IDENTITY_DIAGNOSTIC_RETRIES; attempt += 1) {
    cache = undefined;
    diagnostic = await diagnoseProvider(provider);
    if (diagnostic.identity === (await captureProviderExecutionIdentity(provider)).identity && supported(diagnostic)) {
      return diagnostic;
    }
  }
  throw new ProviderCompatibilityError(provider, diagnostic?.status ?? "launch_failed");
}
/** Final check immediately before sandbox command construction. */
export async function assertProviderExecutionIdentity(provider: AgentId, diagnostic: ProviderDiagnostic, context = currentIdentityContext()) {
  const capture = await captureProviderExecutionIdentity(provider, context);
  if (!supported(diagnostic) || diagnostic.identity !== capture.identity) throw new ProviderCompatibilityError(provider, "launch_failed");
  return capture;
}
function supported(diagnostic: ProviderDiagnostic) { return ["supported", "supported_with_warning"].includes(diagnostic.status); }
export class ProviderCompatibilityError extends Error { readonly provider: AgentId; readonly status: ProviderDiagnostic["status"]; constructor(provider: AgentId, status: ProviderDiagnostic["status"]) { super(`Provider ${provider} is not compatible (${status}). Agent execution is blocked until compatibility is reviewed.`); this.provider = provider; this.status = status; } }
export function acknowledgeProviderVersion(provider: AgentId, version: string) { if (!(provider in providerCompatibilityDefinitions) || !/^\d+(?:\.\d+){2}$/.test(version)) throw new Error("Invalid provider acknowledgement"); getStateStore().acknowledgeProviderCompatibility(provider, version); cache = undefined; }
export function resetProviderDiagnosticsForTests() { cache = undefined; }

async function persist(diagnostic: ProviderDiagnostic, options: Parameters<typeof diagnoseProvider>[1], identity?: string): Promise<ProviderDiagnostic> {
  if (options?.persist === false) return diagnostic;
  const store = getStateStore(); const previous = store.loadLatestProviderCompatibility(diagnostic.provider); const acknowledgedVersion = store.loadProviderCompatibilityAcknowledgement(diagnostic.provider);
  const versionChanged = Boolean(previous?.version && diagnostic.version && previous.version !== diagnostic.version); const identityChanged = Boolean(previous?.identity && identity && previous.identity !== identity);
  const value = { ...diagnostic, previousVersion: versionChanged ? previous!.version : undefined, versionChanged, identityChanged, acknowledgedVersion, identity };
  store.saveProviderCompatibility({ ...value, identity }); return value;
}
function base(provider: AgentId, status: ProviderDiagnostic["status"]): ProviderDiagnostic { return { provider, status, flagsCompatible: false, credentialStatus: "missing", sandboxCompatible: false, launchCompatible: false, checkedAt: new Date().toISOString(), versionChanged: false, identityChanged: false }; }

async function executeInSandbox(provider: AgentId, args: string[], cwd: string, capture?: ProviderIdentityCapture) {
  const binary = provider === "claude" ? join(homedir(), ".local", "bin", "claude") : providerCompatibilityDefinitions[provider].binary;
  const immutable = capture ? await prepareProviderImmutableBinding(provider, capture) : undefined;
  try {
    const command = buildSandboxCommand({ profile: "agent_read_only", provider, cwd, command: { binary, args }, pseudoTty: provider === "cursor", codexRuntime: immutable?.codexRuntime, cursorRuntime: immutable?.cursorRuntime, claudeRuntime: immutable?.claudeRuntime });
    const result = await runHardenedProcess({ binary: command.binary, args: command.args, cwd: command.cwd, env: command.env, purpose: "validation", timeoutMs: 8_000 });
    if (result.timedOut) throw new ProviderDiagnosticTimeoutError();
    return result;
  } finally { await immutable?.cleanup(); }
}
async function providerExecutableIdentity(provider: AgentId): Promise<string | undefined> {
  const identity = await pathIdentity(providerBinaryPath(provider), true);
  return identity?.startsWith("missing") ? undefined : identity;
}
function providerBinaryPath(provider: AgentId, context = currentIdentityContext()) { return provider === "codex" ? join(context.nodeRoot, "lib", "node_modules", "@openai", "codex", "bin", "codex.js") : join(context.home, ".local", "bin", provider === "cursor" ? "agent" : "claude"); }
async function pathIdentity(path: string, executable = false) {
  try {
    const link = await lstat(path);
    const resolved = await realpath(path); if (!resolved.startsWith("/") || /^\/mnt\/[a-z](?:\/|$)/i.test(resolved) || /\.(?:exe|bat|cmd)$/i.test(resolved)) return undefined;
    const info = await stat(resolved); if (!info.isFile() && !info.isDirectory()) return undefined;
    if (executable) await access(resolved, constants.R_OK | constants.X_OK);
    const source = `${link.dev}:${link.ino}:${link.size}:${Math.trunc(link.mtimeMs)}:${link.mode & 0o777}:${link.uid}:${link.gid}`;
    return `${link.isSymbolicLink() ? "symlink" : "file"}:${source}->${resolved}:${info.dev}:${info.ino}:${info.size}:${Math.trunc(info.mtimeMs)}:${info.mode & 0o777}:${info.uid}:${info.gid}`;
  } catch { return "missing"; }
}
async function captureProviderExecutionIdentity(provider: AgentId, context = currentIdentityContext()): Promise<ProviderIdentityCapture> {
  const credentials: Record<AgentId, string> = { codex: join(context.home, ".codex", "auth.json"), cursor: join(context.home, ".config", "cursor", "auth.json"), claude: join(context.home, ".claude", ".credentials.json") };
  const parts = [`policy=${PROVIDER_COMPATIBILITY_POLICY_VERSION}`, `launcher=${await pathIdentity(providerBinaryPath(provider, context), true)}`, `credential=${await pathIdentity(credentials[provider])}`];
  let codexRuntime: CodexRuntimeBinding | undefined;
  let cursorRuntime: CursorRuntimeBinding | undefined;
  let claudeRuntime: ClaudeRuntimeBinding | undefined;
  if (provider === "codex") {
    const resolution = await resolveCodexRuntimeFresh(context.nodeRoot);
    codexRuntime = { ...resolution, nativeIdentity: await executableContentIdentity(resolution.nativeExecutable) };
    parts.push(`node=${await pathIdentity(context.nodePath, true)}`, `packageRoot=${await pathIdentity(codexRuntime.mainPackageRoot)}`, `packageJson=${await pathIdentity(join(codexRuntime.mainPackageRoot, "package.json"))}`, `entry=${await pathIdentity(join(codexRuntime.mainPackageRoot, "bin", "codex.js"), true)}`, `runtimeSource=${codexRuntime.source}`, `runtimeInstall=${await pathIdentity(codexRuntime.installRoot)}`, `runtimePackage=${await pathIdentity(codexRuntime.packageRoot)}`, `runtimePackageJson=${await pathIdentity(codexRuntime.packageJson)}`, `native=${JSON.stringify(codexRuntime.nativeIdentity)}`);
  }
  if (provider === "cursor") {
    const launcher = providerBinaryPath(provider, context); const resolvedLauncher = await realpath(launcher).catch(() => "missing"); const runtimeRoot = resolvedLauncher === "missing" ? "missing" : dirname(resolvedLauncher);
    if (runtimeRoot === "missing") throw new Error("Cursor runtime is unavailable");
    cursorRuntime = await discoverCursorRuntimeManifest(runtimeRoot);
    // Do not hash the installation directory itself: adding an unrelated
    // sibling changes its mtime without changing the closed runtime view.
    parts.push(`runtimeManifest=${cursorRuntime.aggregateDigest}`, `runtimeSourceSecurity=${cursorRuntime.sourceSecurityDigest}`);
  }
  if (provider === "claude") {
    const executable = await realpath(providerBinaryPath(provider, context));
    claudeRuntime = { executable, identity: await executableContentIdentity(executable) };
    parts.push(`runtime=${JSON.stringify(claudeRuntime.identity)}`);
  }
  return { identity: parts.join("|"), codexRuntime, cursorRuntime, claudeRuntime };
}

const CURSOR_CHUNK_NAME = /^\d+\.index\.js$/;
const MAX_CURSOR_RUNTIME_CHUNKS = 512;
const MAX_CURSOR_RUNTIME_CHUNK_BYTES = 128 * 1024 * 1024;

/**
 * Cursor's supported bundled layout uses webpack's deterministic numeric
 * chunk loader.  Read only its entrypoint text; never import or execute it to
 * discover its dependency closure.  The resulting relative names are also
 * the names staged below, so Node can resolve no host installation fallback.
 */
async function discoverCursorRuntimeManifest(runtimeRoot: string): Promise<CursorRuntimeManifest> {
  const indexPath = join(runtimeRoot, "index.js");
  const [launcher, node, index, indexSource] = await Promise.all([
    executableContentIdentity(join(runtimeRoot, "cursor-agent")),
    executableContentIdentity(join(runtimeRoot, "node")),
    executableContentIdentity(indexPath, false),
    readFile(indexPath, "utf8"),
  ]);
  const artifacts: CursorRuntimeManifestArtifact[] = [
    { name: "cursor-agent", identity: launcher },
    { name: "node", identity: node },
    { name: "index.js", identity: index, executable: false },
  ];
  // The supported launcher also derives this sibling executable from
  // process.argv[1] when its sandbox mode is enabled.  Treat it as a required
  // runtime object whenever the entrypoint contains that fixed layout name.
  if (/\bcursorsandbox\b/.test(indexSource)) {
    artifacts.push({ name: "cursorsandbox", identity: await executableContentIdentity(join(runtimeRoot, "cursorsandbox")) });
  }
  // The current supported Cursor bundle uses this webpack mapping for every
  // lazily loaded numbered chunk.  A different loader is an unsupported
  // runtime layout rather than permission to mount the whole install tree.
  const usesNumberedChunks = /__webpack_require__\.u\s*=/.test(indexSource) && /\.index\.js/.test(indexSource) && /require\(\s*["']\.\/["']\s*\+\s*__webpack_require__\.u/.test(indexSource);
  if (usesNumberedChunks) {
    const entries = await readdir(runtimeRoot, { withFileTypes: true });
    const chunks = entries.filter((entry) => CURSOR_CHUNK_NAME.test(entry.name)).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    if (!chunks.length || chunks.length > MAX_CURSOR_RUNTIME_CHUNKS) throw new Error("Cursor runtime has an unsupported chunk layout");
    let totalBytes = 0;
    for (const name of chunks) {
      const identity = await executableContentIdentity(join(runtimeRoot, name), false);
      totalBytes += identity.size;
      if (totalBytes > MAX_CURSOR_RUNTIME_CHUNK_BYTES) throw new Error("Cursor runtime chunks exceed the supported size limit");
      artifacts.push({ name, identity, executable: false });
    }
  }
  for (const artifact of artifacts) assertCursorRuntimeArtifactSecurity(artifact);
  return {
    runtimeRoot,
    artifacts,
    aggregateDigest: aggregateRuntimeArtifactIdentity(artifacts),
    sourceSecurityDigest: createHash("sha256").update(JSON.stringify([...artifacts].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, executable, identity }) => ({ name, executable: executable !== false, ...identity })))).digest("hex"),
  };
}

function assertCursorRuntimeArtifactSecurity(artifact: CursorRuntimeManifestArtifact) {
  const mode = artifact.identity.mode;
  if (artifact.identity.uid !== process.getuid?.() || (mode & 0o022) !== 0 || (artifact.executable !== false && (mode & 0o111) === 0)) {
    throw new Error(`Cursor runtime artifact has unsafe ownership or mode (${artifact.name})`);
  }
}
export async function prepareCodexImmutableBinding(binding: CodexRuntimeBinding): Promise<{ binding: StagedCodexRuntimeBinding; cleanup: () => Promise<void> }> {
  const staged = await prepareImmutableExecutableBinding(binding.nativeExecutable, binding.nativeIdentity);
  if (staged.digest !== binding.nativeIdentity.digest) throw new Error("Approved Codex runtime digest changed before sandbox launch");
  return { binding: { ...binding, stagedExecutable: staged.path, stagedDigest: staged.digest }, cleanup: staged.cleanup };
}
export async function prepareProviderImmutableBinding(provider: AgentId, capture: ProviderIdentityCapture): Promise<{ codexRuntime?: StagedCodexRuntimeBinding; cursorRuntime?: StagedCursorRuntimeBinding; claudeRuntime?: StagedClaudeRuntimeBinding; cleanup: () => Promise<void> }> {
  if (provider === "codex" && capture.codexRuntime) {
    const prepared = await prepareCodexImmutableBinding(capture.codexRuntime);
    return { codexRuntime: prepared.binding, cleanup: prepared.cleanup };
  }
  if (provider === "cursor" && capture.cursorRuntime) {
    const binding = capture.cursorRuntime;
    const staged = await prepareImmutableRuntimeBinding(binding.artifacts.map((artifact) => ({ ...artifact, sourcePath: join(binding.runtimeRoot, artifact.name) })));
    if (staged.aggregateDigest !== binding.aggregateDigest) { await staged.cleanup(); throw new Error("Approved Cursor runtime changed before sandbox launch"); }
    return { cursorRuntime: { stagedRuntimeRoot: staged.directory, aggregateDigest: staged.aggregateDigest }, cleanup: staged.cleanup };
  }
  if (provider === "claude" && capture.claudeRuntime) {
    const staged = await prepareImmutableExecutableBinding(capture.claudeRuntime.executable, capture.claudeRuntime.identity);
    return { claudeRuntime: { stagedExecutable: staged.path, digest: staged.digest }, cleanup: staged.cleanup };
  }
  throw new Error(`Immutable runtime binding is unavailable for ${provider}`);
}
/** Test-only seam for filesystem fixtures; production calls use the host context. */
export async function providerExecutionIdentityForTests(provider: AgentId, context: IdentityContext) { return (await captureProviderExecutionIdentity(provider, context)).identity; }
/** Test-only metadata seam; it reads a Cursor layout but never executes it. */
export async function cursorRuntimeManifestForTests(runtimeRoot: string) { return discoverCursorRuntimeManifest(runtimeRoot); }
export class ProviderDiagnosticTimeoutError extends Error { constructor() { super("Provider diagnostic timed out"); } }
type ResolverProcessResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean };
export async function resolveCodexRuntimeFresh(nodeRoot = currentIdentityContext().nodeRoot, options: { execute?: () => Promise<ResolverProcessResult> } = {}): Promise<CodexRuntimeResolution> {
  const entrypoint = join(nodeRoot, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
  const execute = options.execute ?? (() => runHardenedProcess({
    binary: process.execPath,
    args: [CODEX_RUNTIME_RESOLVER, entrypoint, process.arch],
    cwd: "/",
    env: buildChildProcessEnv({ purpose: "validation", baseEnv: { NODE_ENV: process.env.NODE_ENV, PATH: "/usr/bin:/bin" } }),
    purpose: "validation",
    timeoutMs: CODEX_RUNTIME_RESOLUTION_TIMEOUT_MS,
  }));
  const result = await execute();
  if (result.timedOut) throw new ProviderDiagnosticTimeoutError();
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new Error("Codex runtime resolution failed");
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new Error("Codex runtime resolver returned malformed JSON"); }
  return validateCodexRuntimeResolution(value, nodeRoot);
}
async function validateCodexRuntimeResolution(value: unknown, nodeRoot: string): Promise<CodexRuntimeResolution> {
  const keys = ["installRoot", "mainPackageRoot", "nativeExecutable", "optionalPackageName", "packageJson", "packageRoot", "source"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== keys.join("|")) throw new Error("Codex runtime resolver schema is invalid");
  const resolution = value as Record<string, unknown>;
  if (!Object.values(resolution).every((item) => typeof item === "string") || !["optional", "vendor"].includes(resolution.source as string)) throw new Error("Codex runtime resolver schema is invalid");
  const output = resolution as CodexRuntimeResolution;
  const expectedName = process.arch === "arm64" ? "codex-linux-arm64" : "codex-linux-x64";
  if (output.optionalPackageName !== expectedName) throw new Error("Codex runtime resolver package is invalid");
  const allowedNodeRoot = await realpath(nodeRoot);
  const expectedMain = await realpath(join(nodeRoot, "lib", "node_modules", "@openai", "codex"));
  if (output.mainPackageRoot !== expectedMain || !within(expectedMain, allowedNodeRoot)) throw new Error("Codex runtime resolver main package escaped its installation");
  await validateResolutionPath(output.mainPackageRoot, "directory");
  await validateResolutionPath(output.installRoot, "directory");
  await validateResolutionPath(output.packageRoot, "directory");
  await validateResolutionPath(output.packageJson, "file");
  await validateResolutionPath(output.nativeExecutable, "executable");
  const triple = process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  if (output.packageJson !== join(output.packageRoot, "package.json") || output.nativeExecutable !== join(output.packageRoot, "vendor", triple, "bin", "codex")) throw new Error("Codex runtime resolver paths are inconsistent");
  if (output.source === "vendor") {
    if (output.installRoot !== expectedMain || output.packageRoot !== expectedMain) throw new Error("Codex vendor runtime is inconsistent");
  } else {
    if (!within(output.installRoot, allowedNodeRoot) || !within(output.packageRoot, output.installRoot) || output.installRoot.split(sep).at(-1) !== expectedName || output.installRoot.split(sep).at(-2) !== "@openai") throw new Error("Codex optional runtime escaped its package");
  }
  return output;
}
async function validateResolutionPath(path: string, kind: "directory" | "file" | "executable") {
  if (!isAbsolute(path) || path.includes("\0") || /^\/mnt\/[a-z](?:\/|$)/i.test(path) || await realpath(path) !== path) throw new Error("Codex runtime resolver path is unsafe");
  const info = await lstat(path);
  if (info.isSymbolicLink() || (kind === "directory" ? !info.isDirectory() : !info.isFile())) throw new Error("Codex runtime resolver object is unsafe");
  if (kind === "executable") await access(path, constants.R_OK | constants.X_OK);
}
function within(path: string, root: string) { const value = relative(root, path); return value === "" || (value !== ".." && !value.startsWith(`..${sep}`)); }
async function credentialDiagnostic(provider: AgentId): Promise<ProviderCredentialStatus> {
  try {
    const info = await lstat(credentialPaths[provider]);
    if (!info.isFile() || info.isSymbolicLink()) return "unsupported_layout";
    // The sandbox binds this exact object.  Do not accept credentials owned by
    // another account even when their contents are never read by diagnostics.
    return (info.mode & 0o077) === 0 && info.uid === process.getuid?.() ? "available" : "unsafe_permissions";
  } catch { return "missing"; }
}
function containsFlag(help: string, flag: string) { return new RegExp(`(?:^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,=])`, "m").test(help); }
function safeVersion(result: { stdout: string; stderr: string }) { return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120); }
