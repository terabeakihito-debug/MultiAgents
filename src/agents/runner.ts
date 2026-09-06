import { spawn, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentDefinition, AgentResult } from "./types";
import { beginAgentExecution } from "../server/agent-execution-guard";
import { buildChildProcessEnv } from "../server/child-process-env";
import { redactKnownSecrets } from "../server/credential-resolver";
import { buildGenericRuntimePolicy } from "../server/runtime-policy";
import {
  BWRAP_BINARY,
  SANDBOX_PROJECT_ROOT,
  assertOsSandboxAvailable,
  buildSandboxCommand,
  sandboxProfileForRuntimePolicy,
  OsSandboxUnavailableError,
  type SandboxCommand,
} from "../server/os-sandbox";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

type SpawnLike = typeof spawn;
const FORCE_KILL_GRACE_MS = 2_000;

export function createAgentAdapter(
  definition: AgentDefinition,
  options: {
    cwd?: string;
    env?: Readonly<Record<string, string | undefined>>;
    timeoutMs?: number;
    spawnProcess?: SpawnLike;
    /** Unit-test-only dependency injection. Rejected unless NODE_ENV is test. */
    unsafeTestOnlyBypassOsSandbox?: boolean;
  } = {},
): AgentAdapter {
  assertFixedLauncher(definition);
  return {
    id: definition.id,
    name: definition.name,
    run: (prompt, runOptions) => runProcess(definition, prompt, options, runOptions),
  };
}

function runProcess(
  definition: AgentDefinition,
  prompt: string,
  options: { cwd?: string; env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number; spawnProcess?: SpawnLike; unsafeTestOnlyBypassOsSandbox?: boolean },
  runOptions?: import("./types").AgentRunOptions,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const signal = runOptions?.signal;
    const policy = runOptions?.policy ?? buildGenericRuntimePolicy(definition.id, options.cwd ?? process.cwd());
    const profile = sandboxProfileForRuntimePolicy(policy);
    const audit = runOptions?.onSandboxAudit;
    const testBypass = options.unsafeTestOnlyBypassOsSandbox === true && process.env.NODE_ENV === "test";
    if (policy.agent !== definition.id) {
      resolve(errorResult(definition.id, new Error("Runtime policy agent does not match the fixed launcher")));
      return;
    }
    void launch();

    async function launch() {
      try {
        if (!testBypass) await assertOsSandboxAvailable();
      } catch (error) {
        audit?.({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: error instanceof OsSandboxUnavailableError ? error.failureCode : "namespace_unsupported" });
        resolve(errorResult(definition.id, error));
        return;
      }

      let command: SandboxCommand;
      try {
        const safePrompt = redactKnownSecrets(prompt);
        const innerArgs = definition.args(safePrompt, SANDBOX_PROJECT_ROOT, policy.source === "task_snapshots", policy.allowWrite);
        command = testBypass
          ? testSandboxCommand(definition.binary, innerArgs)
          : buildSandboxCommand({
              profile,
              cwd: policy.workingRoot,
              writableRoot: policy.writableRoot,
              baseRepoRoot: policy.baseRepoRoot,
              provider: definition.id,
              command: { binary: definition.binary, args: innerArgs },
              env: buildChildProcessEnv({ purpose: "agent", baseEnv: options.env ?? process.env }),
            });
      } catch (error) {
        audit?.({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "invalid_sandbox_configuration" });
        resolve(errorResult(definition.id, error));
        return;
      }

      const spawnOptions: SpawnOptions = {
        cwd: command.cwd,
        env: command.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      };
      let child;
      let endAgentExecution: (() => void) | undefined;
      try {
        child = spawnProcess(command.binary, command.args, spawnOptions);
        endAgentExecution = beginAgentExecution();
        audit?.({ type: "os_sandbox_created", profile, provider: definition.id, capabilityClass: policy.policyClass });
      } catch (error) {
        audit?.({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
        resolve(errorResult(definition.id, error));
        return;
      }

      const stdout = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
      const stderr = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
      let finished = false;
      let cleanupAudited = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const cleanupAudit = () => {
        if (cleanupAudited) return;
        cleanupAudited = true;
        audit?.({ type: "os_sandbox_process_cleanup", profile, provider: definition.id, capabilityClass: policy.policyClass });
      };
      const finish = (result: AgentResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        endAgentExecution?.();
        resolve(result);
      };

      child.stdout?.on("data", (chunk) => stdout.append(chunk));
      child.stderr?.on("data", (chunk) => stderr.append(chunk));
      child.on("error", (error) => {
        audit?.({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
        cleanupAudit();
        finish(errorResult(definition.id, error));
      });
      child.on("close", (code, closeSignal) => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        cleanupAudit();
        if (code === 0) {
          finish({ agent: definition.id, status: "completed", output: redactKnownSecrets(stdout.value()).trim() });
          return;
        }
        const diagnostic = stderr.value().trim();
        if (diagnostic.startsWith("bwrap:")) {
          audit?.({ type: "os_sandbox_violation", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
          finish(errorResult(definition.id, new OsSandboxUnavailableError("sandbox_launch_failed")));
          return;
        }
        const exit = `Process exited with code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}`;
        finish({ agent: definition.id, status: "error", output: redactKnownSecrets(stdout.value()).trim(), error: diagnostic ? `${exit}: ${redactKnownSecrets(diagnostic)}` : exit });
      });

      const terminate = () => {
        cleanupAudit();
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          forceKillTimer = setTimeout(() => {
            try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          }, FORCE_KILL_GRACE_MS);
          forceKillTimer.unref();
        } else child.kill("SIGTERM");
      };
      const abort = () => {
        terminate();
        finish({ agent: definition.id, status: "error", output: redactKnownSecrets(stdout.value()).trim(), error: "Request was aborted" });
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        terminate();
        finish({ agent: definition.id, status: "error", output: redactKnownSecrets(stdout.value()).trim(), error: `Process timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` });
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref();
      if (signal?.aborted) abort();
    }
  });
}

function testSandboxCommand(binary: string, args: readonly string[]): SandboxCommand {
  return { binary: BWRAP_BINARY, args: ["--", binary, ...args], cwd: "/", env: { HOME: "/home/runtime", PATH: "/usr/bin:/bin", NODE_ENV: "test" }, sandboxCwd: SANDBOX_PROJECT_ROOT };
}

function assertFixedLauncher(definition: AgentDefinition) {
  const expected: Record<AgentDefinition["id"], string> = {
    codex: "codex",
    cursor: "agent",
    claude: join(process.env.HOME || homedir(), ".local", "bin", "claude"),
  };
  if (definition.binary !== expected[definition.id]) throw new Error(`Invalid fixed launcher for ${definition.id}`);
}

class BoundedUtf8Output {
  private readonly decoder = new StringDecoder("utf8");
  private text = "";
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string) {
    if (this.truncated) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.maxBytes - this.bytes;
    if (buffer.length > remaining) {
      this.text += this.decoder.write(buffer.subarray(0, remaining));
      this.bytes = this.maxBytes;
      this.truncated = true;
      return;
    }
    this.text += this.decoder.write(buffer);
    this.bytes += buffer.length;
  }

  value() {
    return `${this.text}${this.truncated ? `\n[output truncated at ${this.maxBytes} bytes]` : this.decoder.end()}`;
  }
}

function errorResult(agent: AgentDefinition["id"], error: unknown): AgentResult {
  return {
    agent,
    status: "error",
    output: "",
    error: error instanceof Error ? redactKnownSecrets(error.message) : "Failed to start process",
  };
}
