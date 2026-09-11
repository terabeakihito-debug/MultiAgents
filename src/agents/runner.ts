import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentDefinition, AgentResult } from "./types";
import { isReviewFlowTimeoutAbortReason, isReviewStepBudgetAbortReason } from "./abort-origin";
import { assertAgentExecutionAdmissible, beginAgentExecution, captureUnresolvedAgentExecution, durablyQuarantineCapturedUnresolvedAgentExecution, inspectUnresolvedAgentProcess, quarantineUnconfirmedAgentExecution } from "../server/agent-execution-guard";
import { runtimeBindingDirectory } from "../server/immutable-executable-binding";
import { assertProviderExecutionAllowed, assertProviderExecutionIdentity, prepareProviderImmutableBinding } from "../server/provider-diagnostics";
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
const FALLBACK_CLOSE_TIMEOUT_MS = 4_000;
// Sandbox lifecycle records are part of the execution result.  Keep their
// wait bounded so an unavailable audit sink cannot strand an agent forever.
const AUTHORITATIVE_AUDIT_TIMEOUT_MS = 2_000;

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
    let settled = false;
    const settle = (result: AgentResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const spawnProcess = options.spawnProcess ?? spawn;
    const signal = runOptions?.signal;
    const policy = runOptions?.policy ?? buildGenericRuntimePolicy(definition.id, options.cwd ?? process.cwd());
    const profile = sandboxProfileForRuntimePolicy(policy);
    const audit = runOptions?.onSandboxAudit;
    const testBypass = options.unsafeTestOnlyBypassOsSandbox === true && process.env.NODE_ENV === "test";
    let finalizeSpawnedFailure: ((error: unknown) => void) | undefined;
    if (policy.agent !== definition.id) {
      settle(errorResult(definition.id, new Error("Runtime policy agent does not match the fixed launcher")));
      return;
    }
    void launch().catch((error) => {
      if (finalizeSpawnedFailure) {
        finalizeSpawnedFailure(error);
        return;
      }
      // This boundary is reachable only before spawn.  Every path after a
      // ChildProcess exists installs the spawned-child coordinator first.
      settle(errorResult(definition.id, error));
    });

    async function safePreLaunchAudit(event: Parameters<NonNullable<typeof audit>>[0]) {
      try {
        const pending = audit?.(event);
        if (pending && typeof (pending as Promise<void>).then === "function") {
          void Promise.resolve(pending).catch(() => recordAuditFailure(definition.id, "pre_launch"));
        }
        return undefined;
      }
      catch (error) {
        recordAuditFailure(definition.id, "pre_launch");
        return error;
      }
    }

    async function launch() {
      try { assertAgentExecutionAdmissible(); }
      catch (error) { settle(errorResult(definition.id, error)); return; }
      let diagnostic;
      if (!testBypass) try {
        diagnostic = await assertProviderExecutionAllowed(definition.id);
      } catch (error) {
        settle(errorResult(definition.id, error));
        return;
      }
      try {
        if (!testBypass) await assertOsSandboxAvailable();
      } catch (error) {
        await safePreLaunchAudit({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: error instanceof OsSandboxUnavailableError ? error.failureCode : "namespace_unsupported" });
        settle(errorResult(definition.id, error));
        return;
      }

      let command: SandboxCommand;
      let safePrompt = "";
      let innerArgs: string[] = [];
      let executionBinding: Awaited<ReturnType<typeof assertProviderExecutionIdentity>> | undefined;
      let immutableRuntime: Awaited<ReturnType<typeof prepareProviderImmutableBinding>> | undefined;
      try {
        safePrompt = redactKnownSecrets(prompt);
        innerArgs = definition.args(safePrompt, SANDBOX_PROJECT_ROOT, policy.source === "task_snapshots", policy.allowWrite);
        executionBinding = !testBypass ? await assertProviderExecutionIdentity(definition.id, diagnostic!) : undefined;
        immutableRuntime = !testBypass && executionBinding ? await prepareProviderImmutableBinding(definition.id, executionBinding) : undefined;
        command = testBypass
          ? testSandboxCommand(definition.binary, innerArgs)
          : buildSandboxCommand({
              profile,
              cwd: policy.workingRoot,
              writableRoot: policy.writableRoot,
              baseRepoRoot: policy.baseRepoRoot,
              provider: definition.id,
              codexRuntime: immutableRuntime?.codexRuntime,
              cursorRuntime: immutableRuntime?.cursorRuntime,
              claudeRuntime: immutableRuntime?.claudeRuntime,
              command: { binary: definition.binary, args: innerArgs },
              env: buildChildProcessEnv({ purpose: "agent", baseEnv: options.env ?? process.env }),
            });
      } catch (error) {
        await immutableRuntime?.cleanup().catch(() => undefined);
        await safePreLaunchAudit({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "invalid_sandbox_configuration" });
        settle(errorResult(definition.id, error));
        return;
      }

      const spawnOptions: SpawnOptions = {
        cwd: command.cwd,
        env: command.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (definition.id === "codex") logCodexSandboxLaunch(command, innerArgs, safePrompt);
      // This is the final admission decision. There is deliberately no await
      // between lease acquisition and spawn: a newly quarantined process must
      // reject prepared work before it can create an unmanaged child.
      let child;
      let endAgentExecution: (() => void) | undefined;
      try {
        endAgentExecution = beginAgentExecution();
        child = spawnProcess(command.binary, command.args, spawnOptions);
      } catch (error) {
        endAgentExecution?.();
        await immutableRuntime?.cleanup().catch(() => undefined);
        await safePreLaunchAudit({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
        settle(errorResult(definition.id, error));
        return;
      }

      // From here a ChildProcess object exists.  Initialize every state used
      // by close/finalization before attempting optional listener setup.
      // The lease was acquired immediately before synchronous spawn and is now
      // owned by this common spawned-child finalizer.
      const stdout = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
      const stderr = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
      const lifecycle = {
        spawnedAt: new Date().toISOString(),
        stdoutBytes: 0,
        stderrBytes: 0,
      } as import("./types").AgentLifecycleTelemetry;
      let closeObserved = false;
      let finalizing = false;
      let settledSpawned = false;
      let terminationRequested = false;
      let cleanupAudited = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let fallbackCloseTimer: NodeJS.Timeout | undefined;
      let fallbackDeadlineTimer: NodeJS.Timeout | undefined;
      let unconfirmedRetryTimer: NodeJS.Timeout | undefined;
      let fallbackCloseActive = false;
      let finalizationUnconfirmed = false;
      // This is set only by the fallback observer after group death and all
      // owned streams have crossed their close boundary.
      let terminationConfirmed = false;
      let releaseQuarantine: (() => void) | undefined;
      let runtimeCleanupDeferred = false;
      let runtimeCleaned = false;
      let reconcileFallbackClose: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      let abort: (() => void) | undefined;
      let registration: ReturnType<typeof registerChildProcess> | undefined;
      let primaryResult: AgentResult | undefined;
      let primaryOperational = false;
      let terminationReason: import("./types").AgentTerminationReason | undefined;
      let auditError: unknown;
      const authoritativeAudits: Promise<void>[] = [];
      let lifecycleError: unknown;
      // Identity is captured while spawn's leader is known to exist. It is
      // retained for a later durable handoff even if that leader exits first.
      let capturedExecution: ReturnType<typeof captureUnresolvedAgentExecution> | undefined;
      let identityCaptureFailure: unknown;
      try { capturedExecution = captureUnresolvedAgentExecution({ provider: definition.id, pid: child.pid ?? (process.env.NODE_ENV === "test" ? 2 : 0), runtimeBindingPath: runtimeBindingDirectory(immutableRuntime) }); }
      catch (failure) { identityCaptureFailure = failure; }
      const output = () => redactKnownSecrets(stdout.value()).trim();
      const error = (reason: unknown) => errorResult(definition.id, reason);

      const setOperationalFailure = (result: AgentResult, reason?: import("./types").AgentTerminationReason) => {
        if (primaryOperational) return;
        primaryOperational = true;
        primaryResult = result;
        terminationReason = reason;
      };
      const signalChild = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
          return true;
        } catch { try { child.kill(signal); return true; } catch { return false; } }
      };
      const noteSignalRequested = (signal: "SIGTERM" | "SIGKILL") => {
        if (signal === "SIGTERM") lifecycle.sigtermRequestedAt ??= new Date().toISOString();
        else lifecycle.sigkillRequestedAt ??= new Date().toISOString();
      };
      const noteSignalSent = (signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") lifecycle.sigtermSentAt ??= new Date().toISOString();
        if (signal === "SIGKILL") {
          lifecycle.sigkillSentAt ??= new Date().toISOString();
          lifecycle.terminationMethod = "kill_required";
        }
      };
      const requestTermination = () => {
        if (terminationRequested) return;
        terminationRequested = true;
        if (registration?.id) {
          void registration.terminate({
            graceMs: FORCE_KILL_GRACE_MS,
            onSignal: (signal, phase) => {
              if (signal !== "SIGTERM" && signal !== "SIGKILL") return;
              if (phase === "requested") noteSignalRequested(signal);
              else noteSignalSent(signal);
            },
          }).catch((failure) => { lifecycleError ??= failure; });
          return;
        }
        noteSignalRequested("SIGTERM");
        if (signalChild("SIGTERM")) noteSignalSent("SIGTERM");
        forceKillTimer = setTimeout(() => { noteSignalRequested("SIGKILL"); if (signalChild("SIGKILL")) noteSignalSent("SIGKILL"); }, FORCE_KILL_GRACE_MS);
        forceKillTimer.unref();
      };
      const requestFailure = (failure: unknown, terminate = true, reason?: import("./types").AgentTerminationReason) => {
        setOperationalFailure(error(failure), reason);
        if (terminate) requestTermination();
      };

      const cleanupRuntime = async () => {
        if (runtimeCleaned) return;
        await immutableRuntime?.cleanup();
        runtimeCleaned = true;
      };

      // Sandbox lifecycle audits are authoritative when execution otherwise
      // succeeds.  If execution already has an operational failure, the audit
      // remains recorded secondary context and cannot overwrite that result.
      const captureAuditFailure = (event: Parameters<NonNullable<typeof audit>>[0]) => {
        let value: unknown;
        try {
          value = audit?.(event);
        } catch (error) {
          auditError ??= error;
          recordAuditFailure(definition.id, "post_launch");
          return auditError;
        }
        const bounded = boundedAudit(Promise.resolve(value));
        authoritativeAudits.push(bounded);
        void bounded.catch((error) => {
          auditError ??= error;
          recordAuditFailure(definition.id, "post_launch");
          if (!closeObserved) requestTermination();
        });
        return auditError;
      };
      const cleanupAudit = () => {
        if (cleanupAudited) return;
        cleanupAudited = true;
        captureAuditFailure({ type: "os_sandbox_process_cleanup", profile, provider: definition.id, capabilityClass: policy.policyClass });
      };
      const finishAfterClose = async (fallback: AgentResult) => {
        if (finalizing) return;
        finalizing = true;
        if (timer) clearTimeout(timer);
        if (fallbackCloseTimer) clearInterval(fallbackCloseTimer);
        if (fallbackDeadlineTimer) clearTimeout(fallbackDeadlineTimer);
        if (abort) signal?.removeEventListener("abort", abort);
        try { registration?.unregister(); }
        catch (failure) { lifecycleError ??= failure; }
        let verifiedResult = primaryResult ?? fallback;
        let verificationError: unknown;
        try { verifiedResult = await runOptions?.afterClose?.(verifiedResult) ?? verifiedResult; }
        catch (failure) { verificationError = failure; }
        // This is the single post-close audit location for every spawned
        // execution, including setup and registration failures.
        cleanupAudit();
        await Promise.all(authoritativeAudits.map((audit) => audit.catch(() => undefined)));
        let finalResult: AgentResult;
        if (primaryOperational) finalResult = primaryResult!;
        else if (verifiedResult.runtimeViolation) finalResult = verifiedResult;
        else if (verificationError) finalResult = error(verificationError);
        else if (lifecycleError) finalResult = error(lifecycleError);
        else if (auditError) finalResult = error(auditError);
        else finalResult = verifiedResult;
        try { await cleanupRuntime(); }
        catch (failure) { if (!primaryOperational) finalResult = error(failure); }
        const telemetry = { ...lifecycle, ...(terminationReason ? { terminationReason } : {}) };
        try {
          const reported = runOptions?.onLifecycleTelemetry?.(telemetry);
          if (reported && typeof (reported as Promise<void>).then === "function") await boundedAudit(Promise.resolve(reported));
        } catch (failure) {
          if (!primaryOperational) finalResult = error(failure);
        }
        if (terminationReason || runOptions?.onLifecycleTelemetry) {
          finalResult = {
            ...finalResult,
            ...(terminationReason ? { terminationReason } : {}),
            lifecycleTelemetry: telemetry,
          };
        }
        try { endAgentExecution!(); }
        finally {
          if (!settledSpawned) {
            settledSpawned = true;
            settle(finalResult);
          }
        }
      };

      const onClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (closeObserved) return;
        closeObserved = true;
        lifecycle.childClosedAt = new Date().toISOString();
        if (code !== null) lifecycle.exitCode = code;
        if (closeSignal) lifecycle.exitSignal = closeSignal;
        if (lifecycle.sigtermRequestedAt && !lifecycle.sigkillRequestedAt && lifecycle.terminationMethod !== "kill_required") lifecycle.terminationMethod = "term_only";
        if (forceKillTimer) clearTimeout(forceKillTimer);
        // The ChildProcess close event (or its equally strict fallback) is the
        // provider-work boundary. Notify the flow before any post-close
        // verification, cleanup, telemetry, or result settlement begins.
        try { runOptions?.onChildClose?.(); }
        catch { /* lifecycle observers cannot alter process finalization */ }
        if (finalizationUnconfirmed) {
          // A real ChildProcess close event is the canonical lifecycle
          // boundary, including inherited stdio held by descendants.
          terminationConfirmed = true;
          if (terminationConfirmed) void resolveUnconfirmedTermination({ terminationConfirmed: true }).catch((failure) => { lifecycleError ??= failure; });
          return;
        }
        const diagnostic = stderr.value().trim();
        // Do not log provider output verbatim. Both streams can contain the
        // prompt, tool commands, and repository-derived content. Codex stderr
        // is reduced to fixed diagnostic classifications below.
        if (definition.id === "codex" && diagnostic) logCodexStderr(code, closeSignal, diagnostic, prompt);
        let fallback: AgentResult;
        if (code === 0) fallback = { agent: definition.id, status: "completed", output: output() };
        else {
          fallback = diagnostic.startsWith("bwrap:")
            ? error(new OsSandboxUnavailableError("sandbox_launch_failed"))
            : { agent: definition.id, status: "error", output: output(), error: diagnostic ? `Process exited with code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}: ${redactKnownSecrets(diagnostic)}` : `Process exited with code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}` };
          // A requested audit termination has no independent process failure.
          if (!primaryOperational && !auditError) setOperationalFailure(fallback);
        }
        void finishAfterClose(fallback);
      };
      let unconfirmedReconcile: Promise<void> | undefined;
      const scheduleUnconfirmedRetry = () => {
        if (unconfirmedRetryTimer || !finalizationUnconfirmed) return;
        unconfirmedRetryTimer = setTimeout(() => {
          unconfirmedRetryTimer = undefined;
          if (terminationConfirmed) void resolveUnconfirmedTermination({ terminationConfirmed: true }).catch((failure) => { lifecycleError ??= failure; });
        }, 1_000);
        unconfirmedRetryTimer.unref();
      };
      const resolveUnconfirmedTermination = async (confirmation: { terminationConfirmed: true }) => {
        // This resolver is an ownership-release boundary. Its proof is
        // intentionally non-boolean and is checked again at the boundary.
        if (confirmation.terminationConfirmed !== true || !terminationConfirmed) throw new Error("agent_finalization_termination_unconfirmed");
        if (unconfirmedReconcile) return unconfirmedReconcile;
        unconfirmedReconcile = (async () => {
        if (!finalizationUnconfirmed) return;
        try { registration?.unregister(); }
        catch (failure) { lifecycleError ??= failure; }
        if (runtimeCleanupDeferred) {
          try { await cleanupRuntime(); }
          catch (failure) { lifecycleError ??= failure; recordAuditFailure(definition.id, "post_launch"); scheduleUnconfirmedRetry(); return; }
        }
        try { releaseQuarantine?.(); }
        catch (failure) { lifecycleError ??= failure; scheduleUnconfirmedRetry(); return; }
        releaseQuarantine = undefined;
        finalizationUnconfirmed = false;
        if (fallbackCloseTimer) clearInterval(fallbackCloseTimer);
        if (fallbackDeadlineTimer) clearTimeout(fallbackDeadlineTimer);
        if (unconfirmedRetryTimer) clearTimeout(unconfirmedRetryTimer);
        endAgentExecution?.();
        console.warn("agent_finalization_reconciled", JSON.stringify({ agent: definition.id }));
        })().finally(() => { unconfirmedReconcile = undefined; });
        return unconfirmedReconcile;
      };
      const reconcileUnconfirmedProcess = async () => {
        noteSignalRequested("SIGKILL");
        if (signalChild("SIGKILL")) noteSignalSent("SIGKILL");
        // A manual or shutdown retry does not inherit a prior assumption: it
        // obtains a fresh identity/group result and advances only on death.
        if (!capturedExecution) return;
        const status = inspectUnresolvedAgentProcess(capturedExecution);
        if (status !== "TERMINATED") {
          console.warn("agent_finalization_reconcile_pending", JSON.stringify({ agent: definition.id, status }));
          return;
        }
        terminationConfirmed = true;
        reconcileFallbackClose?.();
        await resolveUnconfirmedTermination({ terminationConfirmed: true });
      };
      const settleUnconfirmedTermination = () => {
        if (finalizationUnconfirmed) return;
        finalizationUnconfirmed = true;
        // Handoff occurs before normal guard release, leaving no admission gap.
        let quarantine;
        try {
          if (!capturedExecution) throw identityCaptureFailure ?? new Error("Unable to establish durable managed-process identity");
          quarantine = durablyQuarantineCapturedUnresolvedAgentExecution(capturedExecution, async () => {
              await reconcileUnconfirmedProcess();
            });
        } catch (failure) {
          // Without a committed durable record, retain the ordinary lease as
          // the fail-closed admission barrier. The caller still gets a bounded
          // error, but no new execution is admitted in this server process.
          lifecycleError ??= failure;
          // Persistence failure cannot create a restart-safe record, but it
          // must still be visible to shutdown as unresolved ownership. Keep
          // both this barrier and the ordinary lease; neither is released.
          releaseQuarantine = quarantineUnconfirmedAgentExecution({ reconcile: reconcileUnconfirmedProcess }).release;
          runtimeCleanupDeferred = true;
          captureAuditFailure({ type: "os_sandbox_finalization_persistence_failed", profile, provider: definition.id, capabilityClass: policy.policyClass });
          if (!settledSpawned) { settledSpawned = true; settle({ ...(primaryOperational ? primaryResult! : error(failure)), status: "error", finalizationUnconfirmed: true, finalizationPersistenceFailed: true }); }
          return;
        }
        releaseQuarantine = quarantine.release;
        runtimeCleanupDeferred = true;
        captureAuditFailure({ type: "os_sandbox_finalization_unconfirmed", profile, provider: definition.id, capabilityClass: policy.policyClass });
        const finalResult: AgentResult = {
          ...(primaryOperational ? primaryResult! : error(new Error("agent_finalization_unconfirmed"))),
          status: "error",
          finalizationUnconfirmed: true,
        };
        endAgentExecution!();
        if (!settledSpawned) {
          settledSpawned = true;
          settle(finalResult);
        }
      };
      if (identityCaptureFailure) requestFailure(identityCaptureFailure, true);
      const startFallbackCloseObservation = () => {
        if (fallbackCloseActive) return;
        fallbackCloseActive = true;
        const streams = [child.stdout, child.stderr].filter((stream): stream is NonNullable<typeof stream> => Boolean(stream));
        const streamClosed = new Set(streams.filter((stream) => stream.destroyed || stream.readableEnded));
        const markStreamClosed = (stream: NonNullable<typeof child.stdout>) => {
          streamClosed.add(stream);
          maybeConfirmFallbackClose();
        };
        const groupAlive = () => {
          if (!child.pid || process.platform === "win32") return false;
          try { process.kill(-child.pid, 0); return true; }
          catch (failure) { return !(failure instanceof Error && "code" in failure && failure.code === "ESRCH"); }
        };
        const maybeConfirmFallbackClose = () => {
          // exitCode/signalCode establish only leader exit; the fallback waits
          // for the entire managed group and every owned output stream.
          if (!groupAlive() && streamClosed.size === streams.length) {
            terminationConfirmed = true;
            if (finalizationUnconfirmed) void resolveUnconfirmedTermination({ terminationConfirmed: true }).catch((failure) => { lifecycleError ??= failure; });
            else onClose(null, "SIGKILL");
          }
        };
        reconcileFallbackClose = maybeConfirmFallbackClose;
        for (const stream of streams) {
          try {
            EventEmitter.prototype.once.call(stream, "end", () => markStreamClosed(stream));
            EventEmitter.prototype.once.call(stream, "close", () => markStreamClosed(stream));
          } catch {
            // The deadline below destroys an unobservable stream and returns
            // a fail-closed result if no equivalent close boundary emerges.
          }
        }
        fallbackCloseTimer = setInterval(maybeConfirmFallbackClose, 25);
        fallbackCloseTimer.unref();
        fallbackDeadlineTimer = setTimeout(() => {
          noteSignalRequested("SIGKILL");
          if (signalChild("SIGKILL")) noteSignalSent("SIGKILL");
          for (const stream of streams) {
            try { stream.destroy(); } catch { /* bounded fail-closed fallback */ }
            if (stream.destroyed || stream.readableEnded) markStreamClosed(stream);
          }
          maybeConfirmFallbackClose();
          if (!closeObserved) {
            requestFailure(new Error("Unable to confirm spawned child close boundary"), false);
            settleUnconfirmedTermination();
          }
        }, FALLBACK_CLOSE_TIMEOUT_MS);
        fallbackDeadlineTimer.unref();
        maybeConfirmFallbackClose();
      };
      // Bypass overridable instance listener methods.  ChildProcess inherits
      // EventEmitter, so this remains a confirmed-close observation even when
      // a setup fixture makes child.on/once throw.
      try { EventEmitter.prototype.once.call(child, "close", onClose); }
      catch (failure) {
        try {
          // `on` preserves the actual ChildProcess close boundary too. It is
          // only a one-shot observer in effect because onClose is guarded.
          EventEmitter.prototype.on.call(child, "close", onClose);
        } catch {
          // Only when no EventEmitter-level close observation can be attached
          // do we fall back to group and owned-stream confirmation.
          startFallbackCloseObservation();
        }
        requestFailure(failure, true);
      }
      try { EventEmitter.prototype.once.call(child, "error", (failure: unknown) => {
        captureAuditFailure({ type: "os_sandbox_failed", profile, provider: definition.id, capabilityClass: policy.policyClass, failureCode: "sandbox_launch_failed" });
        if (!child.pid) {
          setOperationalFailure(error(failure));
          onClose(null, null);
          return;
        }
        requestFailure(failure, true);
      }); } catch (failure) { requestFailure(failure, true); }

      finalizeSpawnedFailure = (failure) => requestFailure(failure, true);
      const observeOutput = (stream: "stdout" | "stderr", chunk: unknown) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        const now = new Date().toISOString();
        if (stream === "stdout") {
          lifecycle.stdoutBytes += bytes;
          lifecycle.stdoutFirstByteAt ??= now;
          lifecycle.stdoutLastByteAt = now;
        } else {
          lifecycle.stderrBytes += bytes;
          lifecycle.stderrFirstByteAt ??= now;
          lifecycle.stderrLastByteAt = now;
        }
      };
      try {
        child.stdout?.on("data", (chunk) => { observeOutput("stdout", chunk); stdout.append(chunk); });
        child.stderr?.on("data", (chunk) => { observeOutput("stderr", chunk); stderr.append(chunk); });
        registration = registerChildProcess({ child, purpose: "agent" });
        const createdAuditError = captureAuditFailure({ type: "os_sandbox_created", profile, provider: definition.id, capabilityClass: policy.policyClass });
        if (createdAuditError) requestTermination();
        abort = () => requestFailure(
          new Error("Request was aborted"),
          true,
          isReviewFlowTimeoutAbortReason(signal?.reason)
            ? "flow_aborted"
            : isReviewStepBudgetAbortReason(signal?.reason)
              ? "step_budget_exhausted"
              : "request_aborted",
        );
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          lifecycle.timeoutRequestedAt = new Date().toISOString();
          requestFailure(new Error(`Process timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`), true, "agent_deadline_exceeded");
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        timer.unref();
        if (signal?.aborted) abort();
      } catch (failure) {
        requestFailure(failure, true);
      }
    }
  });
}

function testSandboxCommand(binary: string, args: readonly string[]): SandboxCommand {
  return { binary: BWRAP_BINARY, args: ["--", binary, ...args], cwd: "/", env: { HOME: "/home/runtime", PATH: "/usr/bin:/bin", NODE_ENV: "test" }, sandboxCwd: SANDBOX_PROJECT_ROOT };
}

const CODEX_DIAGNOSTIC_MAX_CHARS = 2_048;
const CODEX_DIAGNOSTIC_MAX_LINES = 32;

const CODEX_STDERR_DIAGNOSTICS: ReadonlyArray<{ kind: string; matches: (line: string) => boolean }> = [
  { kind: "warning", matches: (line) => /\bwarning\s*:/i.test(line) },
  { kind: "error", matches: (line) => /\berror\b/i.test(line) },
  { kind: "failure", matches: (line) => /\bfailure\b|\bfailed to\b/i.test(line) },
  { kind: "missing_file", matches: (line) => /no such file or directory/i.test(line) },
  { kind: "operation_not_permitted", matches: (line) => /operation not permitted/i.test(line) },
  { kind: "permission_denied", matches: (line) => /permission denied/i.test(line) },
];

/**
 * Logs launch facts needed to diagnose the nested Codex/outer-bwrap boundary.
 * The task prompt is deliberately replaced instead of merely redacted: prompts
 * are user-controlled and may contain credentials unknown to the server.
 */
function logCodexSandboxLaunch(command: SandboxCommand, innerArgs: readonly string[], prompt: string) {
  const separator = command.args.indexOf("--");
  const mappedCodexBinary = separator >= 0 ? command.args[separator + 1] : undefined;
  console.warn("codex_sandbox_launch", JSON.stringify({
    outerBubblewrapArgv: safeCodexDiagnosticArgs(command.args, prompt),
    sandboxCwd: command.sandboxCwd,
    mappedCodexBinary,
    innerCodexArgs: safeCodexDiagnosticArgs(innerArgs, prompt),
  }));
}

/**
 * Captures CLI diagnostics independently of the process outcome. Codex can
 * return zero after producing a tool/runtime warning on stderr.
 */
function logCodexStderr(code: number | null, closeSignal: NodeJS.Signals | null, stderr: string, prompt: string) {
  const diagnostics = codexStderrDiagnostics(stderr, prompt);
  // A successful CLI invocation with no recognized harmful diagnostic has no
  // stderr log entry. This avoids making ordinary CLI chatter durable.
  if (diagnostics.length === 0) return;
  console.warn("codex_cli_stderr", JSON.stringify({
    exitCode: code,
    signal: closeSignal,
    stderr: diagnostics,
  }));
}

function safeCodexDiagnosticArgs(args: readonly string[], prompt: string) {
  // codexArgs places the prompt last. Replace every exact copy defensively in
  // case a future command layout uses it more than once.
  return args.map((arg) => arg === prompt ? "[PROMPT_OMITTED]" : redactKnownSecrets(arg));
}

/**
 * Return only fixed diagnostic classifications, never text from stderr.
 * Even an apparent error line may interpolate a prompt, a command, a path,
 * or tool output; retaining its text would make this log an exfiltration path.
 */
function codexStderrDiagnostics(value: string, prompt: string) {
  // Keep secret handling before inspection. The prompt removal is defense in
  // depth; classifications below are fixed strings and do not retain either.
  const safe = redactKnownSecrets(value.split(prompt).join("[PROMPT_OMITTED]"));
  const diagnostics: string[] = [];
  for (const line of safe.split(/\r?\n/)) {
    for (const diagnostic of CODEX_STDERR_DIAGNOSTICS) {
      if (!diagnostic.matches(line)) continue;
      const next = [...diagnostics, diagnostic.kind];
      if (next.length > CODEX_DIAGNOSTIC_MAX_LINES || JSON.stringify(next).length > CODEX_DIAGNOSTIC_MAX_CHARS) return diagnostics;
      diagnostics.push(diagnostic.kind);
    }
    if (diagnostics.length === CODEX_DIAGNOSTIC_MAX_LINES) break;
  }
  return diagnostics;
}

/** Audit persistence must not take ownership of an agent's lifecycle result. */
function recordAuditFailure(agent: AgentDefinition["id"], phase: "pre_launch" | "post_launch") {
  console.warn("agent_audit_failure", JSON.stringify({ agent, phase, reason: "audit_callback_failed" }));
}

function boundedAudit(promise: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Authoritative sandbox audit timed out"))), AUTHORITATIVE_AUDIT_TIMEOUT_MS);
    timer.unref();
    // Both handlers are installed immediately, so a rejection occurring after
    // timeout is still observed rather than becoming an unhandled rejection.
    void promise.then(() => finish(resolve), (error) => finish(() => reject(error)));
  });
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
