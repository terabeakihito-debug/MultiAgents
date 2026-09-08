import { spawn, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentDefinition, AgentResult } from "./types";
import { beginAgentExecution } from "../server/agent-execution-guard";
import { assertProviderExecutionAllowed } from "../server/provider-diagnostics";
import { buildChildProcessEnv } from "../server/child-process-env";
import { registerChildProcess } from "../server/child-process-registry";
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
    supportsPostCloseFinalization: true,
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
      if (!testBypass) try {
        await assertProviderExecutionAllowed(definition.id);
      } catch (error) {
        resolve(errorResult(definition.id, error));
        return;
      }
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
      let registration: ReturnType<typeof registerChildProcess> | undefined;
      try {
        child = spawnProcess(command.binary, command.args, spawnOptions);
      } catch (error) {
        audit?.({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
        resolve(errorResult(definition.id, error));
        return;
      }

      // From here a ChildProcess object exists. Every later failure is a
      // post-spawn failure and must converge through close finalization.
      const endAgentExecution = beginAgentExecution();
      const stdout = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
      const stderr = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
      let finished = false;
      let terminationRequested = false;
      let pendingResult: AgentResult | undefined;
      let cleanupAudited = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let auditError: unknown;
      let lifecycleError: unknown;
      const auditFailure = (error: unknown) => errorResult(definition.id, error);
      // Auditing is diagnostic side-effect work, never lifecycle control flow.
      // Precedence at settlement is runtime violation/verification failure,
      // then lifecycle cleanup failure, then audit failure, then process result.
      const captureAuditFailure = (event: Parameters<NonNullable<typeof audit>>[0]) => {
        try { audit?.(event); }
        catch (error) { auditError ??= error; }
        return auditError;
      };
      const cleanupAudit = () => {
        if (cleanupAudited) return;
        cleanupAudited = true;
        captureAuditFailure({ type: "os_sandbox_process_cleanup", profile, provider: definition.id, capabilityClass: policy.policyClass });
      };
      // This is deliberately the only completion path after spawn.  A result
      // can be selected by abort, timeout, an error, or normal exit, but is
      // never exposed while the child could still be mutating its worktree.
      const finishAfterClose = async (result: AgentResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        let verifiedResult = result;
        let verificationError: unknown;
        try { verifiedResult = await runOptions?.afterClose?.(result) ?? result; }
        catch (error) { verificationError = error; }
        let finalResult: AgentResult;
        if (verifiedResult.runtimeViolation) finalResult = verifiedResult;
        else if (verificationError) finalResult = errorResult(definition.id, verificationError);
        else if (lifecycleError) finalResult = errorResult(definition.id, lifecycleError);
        else if (auditError) finalResult = errorResult(definition.id, auditError);
        else finalResult = verifiedResult;
        // The guard spans close, unregister, and runtime verification, and
        // must release even if any finalization side effect has failed.
        try { endAgentExecution(); }
        finally { resolve(finalResult); }
      };

      const output = () => redactKnownSecrets(stdout.value()).trim();
      const requestTermination = () => {
        if (terminationRequested) return;
        terminationRequested = true;
        cleanupAudit();
        if (registration?.id) {
          // The shared registry owns process-group TERM/KILL escalation.  Do
          // not await it here: `close` remains the definitive lifecycle gate.
          void registration.terminate({ graceMs: FORCE_KILL_GRACE_MS }).catch((error) => { lifecycleError ??= error; });
        } else {
          const signalDirectGroup = (signal: NodeJS.Signals) => {
            try {
              if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
              else child.kill(signal);
            } catch { try { child.kill(signal); } catch { /* close remains authoritative */ } }
          };
          signalDirectGroup("SIGTERM");
          forceKillTimer = setTimeout(() => signalDirectGroup("SIGKILL"), FORCE_KILL_GRACE_MS);
          forceKillTimer.unref();
        }
      };
      const chooseTerminalResult = (result: AgentResult, terminate = false) => {
        if (finished || pendingResult) return;
        pendingResult = result;
        if (terminate) requestTermination();
      };

      child.stdout?.on("data", (chunk) => stdout.append(chunk));
      child.stderr?.on("data", (chunk) => stderr.append(chunk));
      child.on("error", (error) => {
        captureAuditFailure({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
        // A spawn failure with no PID has no OS child to wait for.
        if (!child.pid) {
          cleanupAudit();
          finishAfterClose(errorResult(definition.id, error));
          return;
        }
        chooseTerminalResult(errorResult(definition.id, error), true);
      });
      child.on("close", (code, closeSignal) => {
        try { registration?.unregister(); }
        catch (error) { lifecycleError ??= error; }
        if (forceKillTimer) clearTimeout(forceKillTimer);
        cleanupAudit();
        if (pendingResult) {
          void finishAfterClose(pendingResult);
          return;
        }
        if (code === 0) {
          void finishAfterClose({ agent: definition.id, status: "completed", output: output() });
          return;
        }
        const diagnostic = stderr.value().trim();
        if (diagnostic.startsWith("bwrap:")) {
          captureAuditFailure({ type: "os_sandbox_violation", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
          void finishAfterClose(errorResult(definition.id, new OsSandboxUnavailableError("sandbox_launch_failed")));
          return;
        }
        const exit = `Process exited with code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}`;
        void finishAfterClose({ agent: definition.id, status: "error", output: output(), error: diagnostic ? `${exit}: ${redactKnownSecrets(diagnostic)}` : exit });
      });
      const abort = () => {
        chooseTerminalResult({ agent: definition.id, status: "error", output: output(), error: "Request was aborted" }, true);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        chooseTerminalResult({ agent: definition.id, status: "error", output: output(), error: `Process timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` }, true);
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref();
      try {
        registration = registerChildProcess({ child, purpose: "agent" });
        const createdAuditFailure = captureAuditFailure({ type: "os_sandbox_created", profile, provider: definition.id, capabilityClass: policy.policyClass });
        if (createdAuditFailure) chooseTerminalResult(auditFailure(createdAuditFailure), true);
        if (signal?.aborted) abort();
      } catch (error) {
        // Listener setup is complete, so this post-spawn failure follows the
        // exact same TERM/KILL -> close -> verification finalization path.
        chooseTerminalResult(auditFailure(error), true);
      }
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
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string) {
    if (this.truncated) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.maxBytes - this.bytes;
    if (buffer.length > remaining) {
      this.chunks.push(buffer.subarray(0, remaining));
      this.bytes = this.maxBytes;
      this.truncated = true;
      return;
    }
    this.chunks.push(buffer);
    this.bytes += buffer.length;
  }

  value() {
    const buffer = Buffer.concat(this.chunks, this.bytes);
    const incomplete = incompleteUtf8SuffixBytes(buffer);
    if (incomplete) this.truncated = true;
    const text = buffer.subarray(0, buffer.length - incomplete).toString("utf8");
    return `${text}${this.truncated ? `\n[output truncated at ${this.maxBytes} bytes]` : ""}`;
  }
}

function incompleteUtf8SuffixBytes(buffer: Buffer) {
  if (!buffer.length) return 0;
  let continuation = 0;
  for (let index = buffer.length - 1; index >= 0 && continuation < 3 && (buffer[index] & 0xc0) === 0x80; index -= 1) continuation += 1;
  const leadIndex = buffer.length - continuation - 1;
  if (leadIndex < 0) return Math.min(buffer.length, continuation);
  const lead = buffer[leadIndex];
  const expected = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  const present = continuation + 1;
  return expected > present ? present : 0;
}

function errorResult(agent: AgentDefinition["id"], error: unknown): AgentResult {
  return {
    agent,
    status: "error",
    output: "",
    error: error instanceof Error ? redactKnownSecrets(error.message) : "Failed to start process",
  };
}
