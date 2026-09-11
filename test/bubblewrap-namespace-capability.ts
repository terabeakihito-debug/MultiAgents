import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access as nodeAccess } from "node:fs/promises";

export type BubblewrapNamespaceCapability = { available: true } | { available: false; reason: string };
export type BubblewrapProbeResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean };
export type BubblewrapNamespaceCapabilityDependencies = {
  platform?: NodeJS.Platform;
  binary?: string;
  access?: (path: string, mode: number) => Promise<void>;
  run?: (binary: string, args: readonly string[], timeoutMs: number) => Promise<BubblewrapProbeResult>;
};

const BWRAP = "/usr/bin/bwrap";
const OK = "BWRAP_NAMESPACE_OK";
const timeoutMs = 5_000;

/** Test-host-only probe. It neither imports nor changes production sandbox checks. */
export async function probeBubblewrapNamespaceCapability(dependencies: BubblewrapNamespaceCapabilityDependencies = {}): Promise<BubblewrapNamespaceCapability> {
  if ((dependencies.platform ?? process.platform) !== "linux") return { available: false, reason: "platform_not_linux" };
  const binary = dependencies.binary ?? BWRAP;
  const access = dependencies.access ?? nodeAccess;
  try { await access(binary, constants.F_OK); }
  catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { available: false, reason: "bwrap_missing" };
    if (code === "EACCES" || code === "EPERM") return { available: false, reason: code.toLowerCase() };
    throw error;
  }
  try { await access(binary, constants.X_OK); }
  catch (error) {
    const code = errorCode(error);
    if (code === "EACCES") return { available: false, reason: "bwrap_not_executable" };
    if (code === "EPERM") return { available: false, reason: "eperm" };
    throw error;
  }
  let result: BubblewrapProbeResult;
  try { result = await (dependencies.run ?? runProbe)(binary, probeArgs(), timeoutMs); }
  catch (error) {
    const code = errorCode(error);
    if (code === "EPERM" || code === "EACCES") return { available: false, reason: code.toLowerCase() };
    throw error;
  }
  if (result.timedOut) throw new Error("Bubblewrap namespace capability probe timed out");
  if (result.signal) throw new Error("Bubblewrap namespace capability probe terminated by signal");
  if (result.code === 0 && result.stdout === OK) return { available: true };
  if (result.code !== null && result.code !== 0 && isKnownNamespaceDenial(result.stderr)) return { available: false, reason: "namespace_unsupported" };
  throw new Error("Bubblewrap namespace capability probe failed unexpectedly");
}

/** Fixed, content-free CI reporting for intentionally gated integration suites. */
export function reportUnavailableBubblewrapNamespaceCapability(capability: BubblewrapNamespaceCapability) {
  if (!capability.available) console.warn("test_host_capability_unavailable", JSON.stringify({ capability: "bubblewrap_namespace", reason: capability.reason }));
}

export function bubblewrapNamespaceProbeArgsForTests() { return probeArgs(); }

function probeArgs() {
  return ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--clearenv", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/home/runtime", "--setenv", "HOME", "/home/runtime", "--setenv", "PATH", "/usr/bin:/bin", "--", "/bin/sh", "-c", `printf ${OK}`];
}

function isKnownNamespaceDenial(stderr: string) {
  return /Operation not permitted|Failed to create NETLINK_ROUTE socket|No permissions to create new namespace|user namespace[^\n]{0,80}(disabled|not permitted)/i.test(stderr.slice(0, 512));
}

function errorCode(error: unknown) { return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined; }

function runProbe(binary: string, args: readonly string[], limit: number): Promise<BubblewrapProbeResult> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(binary, [...args], { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test" }, shell: false, stdio: ["ignore", "pipe", "pipe"] as const });
    let stdout = ""; let stderr = ""; let timedOut = false; let settled = false;
    const finish = (result: BubblewrapProbeResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout = (stdout + value).slice(0, 512); });
    child.stderr.on("data", (value: string) => { stderr = (stderr + value).slice(0, 512); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limit);
    child.once("error", fail);
    child.once("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
  });
}
