import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { codexArgs } from "./codex";
import { cursorArgs } from "./cursor";
import { claudeArgs } from "./claude";
import { createAgentAdapter } from "./runner";
import { reviewFlowTimeoutAbortReason, reviewStepBudgetAbortReason } from "./abort-origin";
import { buildGenericRuntimePolicy } from "../server/runtime-policy";
import { isAgentExecutionActive } from "../server/agent-execution-guard";
import { activeChildProcesses } from "../server/child-process-registry";
import type { AgentId } from "./types";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_BINARY = join(process.env.HOME || homedir(), ".local", "bin", "claude");

function policy(agent: AgentId, root: string, write = false) {
  const base = buildGenericRuntimePolicy(agent, root);
  return write ? { ...base, role: "implement" as const, policyClass: "repository_implementation" as const, source: "task_snapshots" as const, filesystem: ["worktree_read" as const, "worktree_write" as const], allowWrite: true, writableRoot: root } : base;
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; pid?: number };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe("createAgentAdapter", () => {
  it("passes the prompt as one argument with shell disabled", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const adapter = createAgentAdapter(
      { id: "codex", name: "Codex", binary: "codex", args: (prompt, cwd) => ["exec", "--cd", cwd, prompt] },
      { cwd: "/workspace", unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("hello; touch /tmp/nope");
    child.stdout.write("CODEX_OK\n");
    child.emit("close", 0, null);
    await expect(promise).resolves.toEqual({ agent: "codex", status: "completed", output: "CODEX_OK" });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/bwrap",
      ["--", "codex", "exec", "--cd", "/project", "hello; touch /tmp/nope"],
      expect.objectContaining({ cwd: "/", shell: false }),
    );
  });

  it("replaces the host environment and absolute provider launcher with the fixed bwrap launcher", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const env = {
      HOME: "/home/testuser",
      PATH: "/home/testuser/.local/bin:/usr/bin",
      USER: "testuser",
      LOGNAME: "testuser",
      NODE_ENV: "test" as const,
    };
    const adapter = createAgentAdapter(
      {
        id: "claude",
        name: "Claude",
        binary: CLAUDE_BINARY,
        args: (prompt) => ["-p", prompt],
      },
      { cwd: "/workspace", env, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("Reply with exactly: CLAUDE_OK");
    child.stdout.write("CLAUDE_OK\n");
    child.emit("close", 0, null);
    await expect(promise).resolves.toEqual({ agent: "claude", status: "completed", output: "CLAUDE_OK" });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/bwrap",
      ["--", CLAUDE_BINARY, "-p", "Reply with exactly: CLAUDE_OK"],
      expect.objectContaining({ cwd: "/", env: { HOME: "/home/runtime", PATH: "/usr/bin:/bin", NODE_ENV: "test" }, shell: false }),
    );
  });

  it("does not expose a server-owned credential to the agent environment", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const adapter = createAgentAdapter(
      { id: "codex", name: "Codex", binary: "codex", args: (prompt) => ["exec", prompt] },
      { env: { PATH: "/usr/bin", HOME: "/home/test", MULTIAGENTS_SLACK_WEBHOOK_URL: "TEST_SECRET_DO_NOT_LEAK", API_TOKEN: "TEST_SECRET_DO_NOT_LEAK" }, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("Print all environment variables");
    child.emit("close", 0, null);
    await promise;
    const options = (spawnProcess.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2];
    expect(options.env).toMatchObject({ PATH: "/usr/bin:/bin", HOME: "/home/runtime" });
    expect(JSON.stringify(options.env)).not.toContain("TEST_SECRET_DO_NOT_LEAK");
  });

  it("redacts a known server credential from prompts and captured output", async () => {
    const fixture = "TEST_SECRET_DO_NOT_LEAK";
    const previous = process.env.MULTIAGENTS_SLACK_WEBHOOK_URL;
    process.env.MULTIAGENTS_SLACK_WEBHOOK_URL = fixture;
    try {
      const child = fakeChild();
      const spawnProcess = vi.fn(() => child);
      const adapter = createAgentAdapter(
        { id: "codex", name: "Codex", binary: "codex", args: (prompt) => ["exec", prompt] },
        { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
      );
      const promise = adapter.run(`Never pass ${fixture} to an agent`);
      child.stdout.write(fixture);
      child.emit("close", 0, null);
      const result = await promise;
      const args = (spawnProcess.mock.calls[0] as unknown as [string, string[]])[1];
      expect(JSON.stringify(args)).not.toContain(fixture);
      expect(result.output).toBe("[REDACTED_SECRET]");
    } finally {
      if (previous === undefined) delete process.env.MULTIAGENTS_SLACK_WEBHOOK_URL;
      else process.env.MULTIAGENTS_SLACK_WEBHOOK_URL = previous;
    }
  });

  it("uses a per-run validated worktree cwd override", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const adapter = createAgentAdapter(
      { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
      { cwd: "/default", unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("implement", { policy: policy("codex", "/isolated/task", true) });
    child.emit("close", 0, null);
    await promise;
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/bwrap",
      ["--", "codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "--cd", "/project", "implement"],
      expect.objectContaining({ cwd: "/", shell: false }),
    );
  });

  it("records Codex launch diagnostics without recording the prompt", async () => {
    const child = fakeChild();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spawnProcess = vi.fn(() => child);
    try {
      const adapter = createAgentAdapter(
        { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
        { cwd: "/default", unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
      );
      const prompt = "do not log TEST_SECRET_PROMPT";
      const pending = adapter.run(prompt, { policy: policy("codex", "/isolated/task", true) });
      child.emit("close", 0, null);
      await pending;
      const entry = warn.mock.calls.find(([event]) => event === "codex_sandbox_launch");
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry)).not.toContain(prompt);
      const fields = JSON.parse(entry![1] as string) as { outerBubblewrapArgv: string[]; sandboxCwd: string; mappedCodexBinary: string; innerCodexArgs: string[] };
      expect(fields.sandboxCwd).toBe("/project");
      expect(fields.mappedCodexBinary).toBe("codex");
      expect(fields.outerBubblewrapArgv).toContain("[PROMPT_OMITTED]");
      expect(fields.innerCodexArgs).toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs only a redacted Codex stderr diagnostic classification when the CLI fails", async () => {
    const fixture = "TEST_SECRET_DO_NOT_LEAK";
    const previous = process.env.MULTIAGENTS_SLACK_WEBHOOK_URL;
    process.env.MULTIAGENTS_SLACK_WEBHOOK_URL = fixture;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = fakeChild();
      const adapter = createAgentAdapter(
        { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
        { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
      );
      const pending = adapter.run("implement", { policy: policy("codex", "/isolated/task", true) });
      child.stderr.write(`failure: ${fixture}`);
      child.emit("close", 1, null);
      await pending;
      const entry = warn.mock.calls.find(([event]) => event === "codex_cli_stderr");
      expect(entry).toBeDefined();
      expect(JSON.parse(entry![1] as string).stderr).toContain("failure");
      expect(JSON.stringify(entry)).not.toContain(fixture);
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env.MULTIAGENTS_SLACK_WEBHOOK_URL;
      else process.env.MULTIAGENTS_SLACK_WEBHOOK_URL = previous;
    }
  });

  it("logs only recognized Codex stderr diagnostics even when the CLI exits successfully", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = fakeChild();
      const adapter = createAgentAdapter(
        { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
        { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
      );
      const pending = adapter.run("read only", { policy: policy("codex", "/isolated/task", true) });
      child.stderr.write("warning: tool command output that must not be logged");
      child.emit("close", 0, null);
      await expect(pending).resolves.toMatchObject({ status: "completed" });
      expect(warn).toHaveBeenCalledWith("codex_cli_stderr", expect.stringContaining('"exitCode":0'));
      const entry = warn.mock.calls.find(([event]) => event === "codex_cli_stderr");
      expect(JSON.parse(entry![1] as string).stderr).toContain("warning");
      expect(JSON.stringify(entry)).not.toContain("tool command output that must not be logged");
    } finally {
      warn.mockRestore();
    }
  });

  it("never logs Codex prompts or repository-derived stderr text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = fakeChild();
      const adapter = createAgentAdapter(
        { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
        { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
      );
      const prompt = "USER_PROMPT_MUST_NEVER_APPEAR";
      const repositoryText = "REPOSITORY_DERIVED_TOOL_OUTPUT_MUST_NEVER_APPEAR";
      const pending = adapter.run(prompt, { policy: policy("codex", "/isolated/task", true) });
      child.stderr.write(`ERROR: ${prompt}\ntool output: ${repositoryText}\nfailed to apply patch: ${repositoryText}`);
      child.emit("close", 1, null);
      await pending;
      const entry = warn.mock.calls.find(([event]) => event === "codex_cli_stderr");
      expect(entry).toBeDefined();
      const logged = JSON.stringify(entry);
      expect(logged).not.toContain(prompt);
      expect(logged).not.toContain(repositoryText);
      expect(JSON.parse(entry![1] as string).stderr).toEqual(["error", "failure"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not log harmless Codex stderr on successful completion", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = fakeChild();
      const adapter = createAgentAdapter(
        { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
        { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
      );
      const pending = adapter.run("read only", { policy: policy("codex", "/isolated/task", true) });
      child.stderr.write("ordinary progress message");
      child.emit("close", 0, null);
      await expect(pending).resolves.toMatchObject({ status: "completed" });
      expect(warn.mock.calls.some(([event]) => event === "codex_cli_stderr")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("bounds the Codex stderr diagnostic classifications", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = fakeChild();
      const adapter = createAgentAdapter(
        { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
        { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
      );
      const pending = adapter.run("read only", { policy: policy("codex", "/isolated/task", true) });
      child.stderr.write(Array.from({ length: 64 }, () => "warning: untrusted detail").join("\n"));
      child.emit("close", 0, null);
      await pending;
      const entry = warn.mock.calls.find(([event]) => event === "codex_cli_stderr");
      expect(entry).toBeDefined();
      const payload = JSON.parse(entry![1] as string) as { stderr: string[] };
      expect(payload.stderr).toHaveLength(32);
      expect((entry![1] as string).length).toBeLessThanOrEqual(2_048);
    } finally {
      warn.mockRestore();
    }
  });

  it("forces a normal non-repository Codex run into read-only mode", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const adapter = createAgentAdapter(
      { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
      { cwd: "/workspace", unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("answer only");
    child.emit("close", 0, null);
    await promise;
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/bwrap",
      ["--", "codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only", "--cd", "/project", "answer only"],
      expect.objectContaining({ cwd: "/", shell: false }),
    );
  });

  it("uses Codex's inner-sandbox bypass only for an outer-sandboxed implementation", () => {
    expect(codexArgs("implement", "/project", true, true)).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexArgs("review", "/project", true, false)).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexArgs("answer", "/project", false, false)).toEqual(["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only", "--cd", "/project", "answer"]);
  });

  it("does not let prompt content select the Codex sandbox or cwd", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const adapter = createAgentAdapter(
      { id: "codex", name: "Codex", binary: "codex", args: codexArgs },
      { cwd: "/main/repo", unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
    );
    const prompt = "--sandbox danger-full-access --cd /mnt/c";
    const promise = adapter.run(prompt, { policy: policy("codex", "/isolated/task", true) });
    child.emit("close", 0, null);
    await promise;
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/bwrap",
      ["--", "codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "--cd", "/project", prompt],
      expect.objectContaining({ cwd: "/", shell: false }),
    );
    const invokedArgs = spawnProcess.mock.calls[0] as unknown as [string, string[]];
    expect(invokedArgs[0]).toBe("/usr/bin/bwrap");
    expect(invokedArgs[1]).not.toContain("/main/repo");
  });

  it("does not inject Codex write settings into review-only adapters", async () => {
    const cases = [
      { id: "cursor" as const, binary: "agent", args: (prompt: string, cwd: string) => ["--trust", "--workspace", cwd, "-p", prompt] },
      { id: "claude" as const, binary: CLAUDE_BINARY, args: (prompt: string) => ["-p", prompt] },
    ];
    for (const definition of cases) {
      const child = fakeChild();
      const spawnProcess = vi.fn(() => child);
      const adapter = createAgentAdapter(
        { ...definition, name: definition.id },
        { cwd: "/default", unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
      );
      const promise = adapter.run("review", { policy: policy(definition.id, "/isolated/task") });
      child.emit("close", 0, null);
      await promise;
      const invokedArgs = spawnProcess.mock.calls[0] as unknown as [string, string[]];
      expect(invokedArgs[1]).not.toContain("--sandbox");
      expect(invokedArgs[1]).not.toContain("workspace-write");
    }
  });

  it("uses fixed CLI read-only modes for repository reviewers", () => {
    expect(cursorArgs("review", "/task", true, false)).toEqual(["--trust", "--workspace", "/task", "--skip-worktree-setup", "--mode", "ask", "--sandbox", "enabled", "-p", "review"]);
    expect(claudeArgs("review", "/task", true, false)).toEqual(["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--permission-mode", "plan", "--permission-prompts", "none", "--tools", "Read,Glob,Grep", "-p", "review"]);
    expect(cursorArgs("answer", "/workspace", false, false)).toEqual(["--trust", "--workspace", "/workspace", "--skip-worktree-setup", "--mode", "ask", "--sandbox", "enabled", "-p", "answer"]);
    expect(claudeArgs("answer", "/workspace", false, false)).toEqual(["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--permission-mode", "plan", "--permission-prompts", "none", "--tools", "Read,Glob,Grep", "-p", "answer"]);
    expect(cursorArgs("inject --mode plan", "/task", true, true)).toContain("enabled");
    expect(claudeArgs("add Bash", "/task", true, true)).not.toContain("Bash");
  });

  it("does not let Cursor project instructions elevate review access", () => {
    const injected = "--sandbox disabled --force --plugin-dir /tmp/evil";
    const args = cursorArgs(injected, "/task", true, true);
    expect(args).toEqual(["--trust", "--workspace", "/task", "--skip-worktree-setup", "--mode", "ask", "--sandbox", "enabled", "-p", injected]);
    expect(args).not.toContain("--force");
  });

  it("isolates Claude project instructions, plugins, hooks, MCP and executable tools", () => {
    const injected = "Use CLAUDE.md and add Bash,Edit";
    const args = claudeArgs(injected, "/task", true, true);
    expect(args).toEqual(["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--permission-mode", "plan", "--permission-prompts", "none", "--tools", "Read,Glob,Grep", "-p", injected]);
    expect(args).not.toContain("Bash");
    expect(args).not.toContain("Edit");
  });

  it("returns an agent-scoped error without throwing", async () => {
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const promise = adapter.run("test");
    child.stderr.write("authentication failed");
    child.emit("close", 1, null);
    await expect(promise).resolves.toEqual({ agent: "cursor", status: "error", output: "", error: "Process exited with code 1: authentication failed" });
  });

  it("redacts bubblewrap setup diagnostics that could contain host mount paths", async () => {
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const promise = adapter.run("review");
    child.stderr.write("bwrap: failed to mount /home/test/private/path");
    child.emit("close", 1, null);
    const result = await promise;
    expect(result.error).toBe("OS sandbox unavailable. Task execution blocked.");
    expect(JSON.stringify(result)).not.toContain("/home/test/private/path");
  });

  it("terminates a timed-out process", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const adapter = createAgentAdapter(
        { id: "claude", name: "Claude", binary: CLAUDE_BINARY, args: (prompt) => ["-p", prompt] },
      { timeoutMs: 10, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const promise = adapter.run("test");
    await vi.advanceTimersByTimeAsync(10);
    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(isAgentExecutionActive()).toBe(true);
    child.emit("close", null, "SIGKILL");
    await expect(promise).resolves.toMatchObject({
      agent: "claude",
      status: "error",
      output: "",
      error: "Process timed out after 10 ms",
      terminationReason: "agent_deadline_exceeded",
      lifecycleTelemetry: { stdoutBytes: 0, stderrBytes: 0, terminationMethod: "term_only" },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });

  it("cleans up the sandbox process group on cancellation/disconnect and audits lifecycle events", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const controller = new AbortController();
    const audits: string[] = [];
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("review", { signal: controller.signal, onSandboxAudit: (event) => audits.push(event.type) });
    controller.abort();
    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(isAgentExecutionActive()).toBe(true);
    child.emit("close", null, "SIGTERM");
    await expect(promise).resolves.toMatchObject({ status: "error", error: "Request was aborted", terminationReason: "request_aborted" });
    expect(isAgentExecutionActive()).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(audits).toEqual(["os_sandbox_created", "os_sandbox_process_cleanup"]);
  });

  it("records only content-free telemetry for timeout, TERM, close, and stream activity", async () => {
    vi.useFakeTimers();
    const secret = "ghp_THIS_MUST_NOT_APPEAR_IN_TELEMETRY_1234567890";
    const child = fakeChild();
    const received: import("./types").AgentLifecycleTelemetry[] = [];
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { timeoutMs: 10, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("prompt must never enter telemetry", { onLifecycleTelemetry: (telemetry) => { received.push(telemetry); } });
    child.stdout.write(secret); child.stderr.write(secret);
    await vi.advanceTimersByTimeAsync(10);
    child.emit("close", null, "SIGTERM");
    const result = await pending;
    expect(result.terminationReason).toBe("agent_deadline_exceeded");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      stdoutBytes: Buffer.byteLength(secret), stderrBytes: Buffer.byteLength(secret),
      terminationMethod: "term_only", terminationReason: "agent_deadline_exceeded",
    });
    expect(received[0].stdoutFirstByteAt).toMatch(/^\d{4}-/);
    expect(received[0].stdoutLastByteAt).toMatch(/^\d{4}-/);
    expect(received[0].stderrFirstByteAt).toMatch(/^\d{4}-/);
    expect(received[0].stderrLastByteAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(received[0])).not.toContain(secret);
    expect(JSON.stringify(received[0])).not.toContain("prompt must never enter telemetry");
    vi.useRealTimers();
  });

  it("records SIGKILL only when TERM did not close the child", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const received: import("./types").AgentLifecycleTelemetry[] = [];
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { timeoutMs: 10, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { onLifecycleTelemetry: (telemetry) => { received.push(telemetry); } });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
    await pending;
    expect(received[0]).toMatchObject({ terminationMethod: "kill_required" });
    expect(received[0].sigkillRequestedAt).toMatch(/^\d{4}-/);
    expect(received[0].sigkillSentAt).toMatch(/^\d{4}-/);
    vi.useRealTimers();
  });

  it("records registered TERM termination before unregistering the child", async () => {
    vi.useFakeTimers();
    const child = fakeChild(); Object.defineProperty(child, "pid", { value: 987_654 });
    const received: import("./types").AgentLifecycleTelemetry[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { timeoutMs: 10, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { onLifecycleTelemetry: (telemetry) => { received.push(telemetry); } });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith(-987_654, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await pending;
    expect(activeChildProcesses()).toEqual([]);
    expect(received[0]).toMatchObject({ terminationMethod: "term_only" });
    expect(received[0].sigtermRequestedAt).toMatch(/^\d{4}-/);
    expect(received[0].sigtermSentAt).toMatch(/^\d{4}-/);
    expect(received[0].sigkillRequestedAt).toBeUndefined();
    expect(received[0].sigkillSentAt).toBeUndefined();
    vi.useRealTimers();
  });

  it("records registered SIGKILL request and send without reverting termination provenance on close", async () => {
    vi.useFakeTimers();
    const child = fakeChild(); Object.defineProperty(child, "pid", { value: 987_655 });
    const received: import("./types").AgentLifecycleTelemetry[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { timeoutMs: 10, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { onLifecycleTelemetry: (telemetry) => { received.push(telemetry); } });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(kill).toHaveBeenCalledWith(-987_655, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-987_655, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await pending;
    expect(activeChildProcesses()).toEqual([]);
    expect(received[0]).toMatchObject({ terminationMethod: "kill_required" });
    expect(received[0].sigkillRequestedAt).toMatch(/^\d{4}-/);
    expect(received[0].sigkillSentAt).toMatch(/^\d{4}-/);
    vi.useRealTimers();
  });

  it("keeps the abort result stable when abort and timeout race until close", async () => {
    vi.useFakeTimers();
    const child = fakeChild(); const controller = new AbortController();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { timeoutMs: 10, unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { signal: controller.signal });
    controller.abort(); await vi.advanceTimersByTimeAsync(10);
    expect(isAgentExecutionActive()).toBe(true);
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ error: "Request was aborted" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("classifies a genuine review-flow timeout structurally", async () => {
    const child = fakeChild(); const controller = new AbortController();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { signal: controller.signal });
    controller.abort(reviewFlowTimeoutAbortReason());
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ error: "Request was aborted", terminationReason: "flow_aborted" });
  });

  it("classifies a step-budget abort structurally and completes registered TERM-to-KILL cleanup", async () => {
    vi.useFakeTimers();
    const child = fakeChild(); Object.defineProperty(child, "pid", { value: 987_656 });
    const controller = new AbortController();
    const received: import("./types").AgentLifecycleTelemetry[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { signal: controller.signal, onLifecycleTelemetry: (telemetry) => { received.push(telemetry); } });
    controller.abort(reviewStepBudgetAbortReason());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(kill).toHaveBeenCalledWith(-987_656, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-987_656, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await expect(pending).resolves.toMatchObject({ terminationReason: "step_budget_exhausted" });
    expect(received[0]).toMatchObject({ terminationReason: "step_budget_exhausted", terminationMethod: "kill_required" });
    expect(activeChildProcesses()).toEqual([]);
    vi.useRealTimers();
  });

  it("does not depend on step-budget diagnostic text", async () => {
    const child = fakeChild(); const controller = new AbortController();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { signal: controller.signal });
    controller.abort(reviewStepBudgetAbortReason("A future step budget display message"));
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ terminationReason: "step_budget_exhausted" });
  });

  it("classifies an external abort with the old timeout text as request-originated", async () => {
    const child = fakeChild(); const controller = new AbortController();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { signal: controller.signal });
    controller.abort(new Error("Review flow timed out"));
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ error: "Request was aborted", terminationReason: "request_aborted" });
  });

  it("does not depend on review-flow timeout diagnostic text", async () => {
    const child = fakeChild(); const controller = new AbortController();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { signal: controller.signal });
    controller.abort(reviewFlowTimeoutAbortReason("A future display message"));
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ error: "Request was aborted", terminationReason: "flow_aborted" });
  });

  it("settles a PID-less spawn error because no OS child exists", async () => {
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review");
    child.emit("error", new Error("spawn unavailable"));
    await expect(pending).resolves.toMatchObject({ status: "error", error: "spawn unavailable" });
    expect(isAgentExecutionActive()).toBe(false);
  });

  it("keeps the guard and result pending while post-close verification runs", async () => {
    const child = fakeChild();
    let releaseVerification!: () => void;
    const verification = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    let settled = false;
    const pending = adapter.run("review", { afterClose: async (result) => { await verification; return result; } }).then((result) => { settled = true; return result; });
    child.emit("close", 0, null);
    await Promise.resolve();
    expect(isAgentExecutionActive()).toBe(true);
    expect(settled).toBe(false);
    releaseVerification();
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    expect(isAgentExecutionActive()).toBe(false);
  });

  it("releases the guard after a post-close verification failure", async () => {
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const pending = adapter.run("review", { afterClose: async () => { throw new Error("verification failed"); } });
    child.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({ status: "error", error: "verification failed" });
    expect(isAgentExecutionActive()).toBe(false);
  });

  it("routes a post-spawn audit failure through close finalization", async () => {
    const child = fakeChild() as ReturnType<typeof fakeChild> & { pid?: number };
    Object.defineProperty(child, "pid", { value: 4321 });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    let settled = false;
    const verify = vi.fn(async (result) => result);
    const pending = adapter.run("review", { afterClose: verify, onSandboxAudit: (event) => { if (event.type === "os_sandbox_created") throw new Error("audit persistence failed"); } }).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(activeChildProcesses()).toMatchObject([{ pid: 4321, purpose: "agent" }]);
    expect(isAgentExecutionActive()).toBe(true);
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ status: "error", error: "audit persistence failed" });
    expect(verify).toHaveBeenCalledOnce();
    expect(activeChildProcesses()).toEqual([]);
    expect(isAgentExecutionActive()).toBe(false);
    expect(kill).toHaveBeenCalledWith(-4321, "SIGTERM");
    kill.mockRestore();
  });

  it("preserves a process failure when its audit also fails", async () => {
    const child = fakeChild() as ReturnType<typeof fakeChild> & { pid?: number };
    Object.defineProperty(child, "pid", { value: 4322 });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const verify = vi.fn(async (result) => result);
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    let settled = 0;
    const pending = adapter.run("review", {
      afterClose: verify,
      onSandboxAudit: (event) => { if (event.type === "os_sandbox_failed") throw new Error("failed audit persistence"); },
    }).then((result) => { settled += 1; return result; });
    child.emit("error", new Error("transport failed"));
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith(-4322, "SIGTERM");
    expect(activeChildProcesses()).toMatchObject([{ pid: 4322 }]);
    expect(isAgentExecutionActive()).toBe(true);
    expect(settled).toBe(0);
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ status: "error", error: "transport failed" });
    expect(verify).toHaveBeenCalledOnce();
    expect(activeChildProcesses()).toEqual([]);
    expect(isAgentExecutionActive()).toBe(false);
    expect(settled).toBe(1);
    kill.mockRestore();
  });

  it("preserves a sandbox-violation result when its audit fails", async () => {
    const child = fakeChild() as ReturnType<typeof fakeChild> & { pid?: number };
    Object.defineProperty(child, "pid", { value: 4323 });
    const verify = vi.fn(async (result) => result);
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    let settled = 0;
    const pending = adapter.run("review", {
      afterClose: verify,
      onSandboxAudit: (event) => { if (event.type === "os_sandbox_violation") throw new Error("violation audit failed"); },
    }).then((result) => { settled += 1; return result; });
    child.stderr.write("bwrap: simulated violation");
    child.emit("close", 1, null);
    await expect(pending).resolves.toMatchObject({ status: "error", error: "OS sandbox unavailable. Task execution blocked." });
    expect(verify).toHaveBeenCalledOnce();
    expect(activeChildProcesses()).toEqual([]);
    expect(isAgentExecutionActive()).toBe(false);
    expect(settled).toBe(1);
  });

  it("returns a pre-spawn failure without acquiring the guard or waiting for close", async () => {
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => { throw new Error("spawn failed"); }) as never },
    );
    await expect(adapter.run("review")).resolves.toMatchObject({ status: "error", error: "spawn failed" });
    expect(isAgentExecutionActive()).toBe(false);
    expect(activeChildProcesses()).toEqual([]);
  });

  it("settles once with the primary pre-launch failure when synchronous or asynchronous audits fail", async () => {
    for (const audit of [
      () => { throw new Error("sync audit failed"); },
      async () => { throw new Error("async audit failed"); },
    ]) {
      const adapter = createAgentAdapter(
        { id: "cursor", name: "Cursor", binary: "agent", args: () => { throw new Error("spawn preparation failed"); } },
        { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn() as never },
      );
      let settled = 0;
      await expect(adapter.run("review", { onSandboxAudit: audit }).then((result) => { settled++; return result; })).resolves.toMatchObject({ status: "error", error: "spawn preparation failed" });
      expect(settled).toBe(1);
      expect(activeChildProcesses()).toEqual([]);
      expect(isAgentExecutionActive()).toBe(false);
    }
  });

  it("settles once with the primary spawn failure when a pre-launch audit fails", async () => {
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "agent", args: (prompt) => ["-p", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => { throw new Error("spawn failed"); }) as never },
    );
    let settled = 0;
    await expect(adapter.run("review", { onSandboxAudit: async () => { throw new Error("audit failed"); } }).then((result) => { settled++; return result; })).resolves.toMatchObject({ status: "error", error: "spawn failed" });
    expect(settled).toBe(1);
    expect(activeChildProcesses()).toEqual([]);
  });

  it("rejects a non-fixed launcher path", () => {
    expect(() => createAgentAdapter({ id: "codex", name: "Codex", binary: "/tmp/codex", args: (prompt) => [prompt] })).toThrow("Invalid fixed launcher");
  });

  it("caps output by bytes without splitting a UTF-8 character", async () => {
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "codex", name: "Codex", binary: "codex", args: (prompt) => ["exec", prompt] },
      { unsafeTestOnlyBypassOsSandbox: true, spawnProcess: vi.fn(() => child) as never },
    );
    const promise = adapter.run("test");
    child.stdout.write(Buffer.alloc(999_999, 97));
    child.stdout.write(Buffer.from("あ"));
    child.emit("close", 0, null);
    const result = await promise;
    expect(result.output).toHaveLength(1_000_035);
    expect(result.output.endsWith("a\n[output truncated at 1000000 bytes]")).toBe(true);
    expect(result.output).not.toContain("�");
  });
});
