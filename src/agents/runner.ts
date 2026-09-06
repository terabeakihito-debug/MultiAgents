import { spawn, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentAdapter, AgentDefinition, AgentResult } from "./types";
import { beginAgentExecution } from "../server/agent-execution-guard";
import { buildChildProcessEnv } from "../server/child-process-env";
import { redactKnownSecrets } from "../server/credential-resolver";

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
  } = {},
): AgentAdapter {
  return {
    id: definition.id,
    name: definition.name,
    run: (prompt, runOptions) => runProcess(definition, prompt, options, runOptions),
  };
}

function runProcess(
  definition: AgentDefinition,
  prompt: string,
  options: { cwd?: string; env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number; spawnProcess?: SpawnLike },
  runOptions?: { signal?: AbortSignal; cwd?: string; writeAccess?: boolean },
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const signal = runOptions?.signal;
    const cwd = runOptions?.cwd ?? options.cwd ?? process.cwd();
    const spawnOptions: SpawnOptions = {
      cwd,
      env: buildChildProcessEnv({ purpose: "agent", baseEnv: options.env ?? process.env }),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    };

    let child;
    let endAgentExecution: (() => void) | undefined;
    try {
      // A per-run cwd is supplied only after a server-side repository task lookup.
      // It is intentionally a boolean capability, not a client-selectable sandbox value.
      const safePrompt = redactKnownSecrets(prompt);
      child = spawnProcess(definition.binary, definition.args(safePrompt, cwd, Boolean(runOptions?.cwd), runOptions?.writeAccess ?? Boolean(runOptions?.cwd)), spawnOptions);
      endAgentExecution = beginAgentExecution();
    } catch (error) {
      resolve(errorResult(definition.id, error));
      return;
    }

    const stdout = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
    const stderr = new BoundedUtf8Output(MAX_OUTPUT_BYTES);
    let finished = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: AgentResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      endAgentExecution?.();
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr.append(chunk);
    });
    child.on("error", (error) => finish(errorResult(definition.id, error)));
    child.on("close", (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (code === 0) {
        finish({ agent: definition.id, status: "completed", output: redactKnownSecrets(stdout.value()).trim() });
        return;
      }
      const exit = `Process exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`;
      const diagnostic = stderr.value().trim();
      finish({
        agent: definition.id,
        status: "error",
        output: redactKnownSecrets(stdout.value()).trim(),
        error: diagnostic ? `${exit}: ${redactKnownSecrets(diagnostic)}` : exit,
      });
    });

    const terminate = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        forceKillTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, FORCE_KILL_GRACE_MS);
        forceKillTimer.unref();
      } else {
        child.kill("SIGTERM");
      }
    };

    const abort = () => {
      terminate();
      finish({ agent: definition.id, status: "error", output: redactKnownSecrets(stdout.value()).trim(), error: "Request was aborted" });
    };
    signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(() => {
      terminate();
      finish({
        agent: definition.id,
        status: "error",
        output: redactKnownSecrets(stdout.value()).trim(),
        error: `Process timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`,
      });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();

    if (signal?.aborted) abort();
  });
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
