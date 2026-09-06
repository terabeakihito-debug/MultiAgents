import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { codexArgs } from "./codex";
import { cursorArgs } from "./cursor";
import { claudeArgs } from "./claude";
import { createAgentAdapter } from "./runner";
import { buildGenericRuntimePolicy } from "../server/runtime-policy";
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
      ["--", "codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "workspace-write", "--cd", "/project", "implement"],
      expect.objectContaining({ cwd: "/", shell: false }),
    );
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
      ["--", "codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "workspace-write", "--cd", "/project", prompt],
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
    await expect(promise).resolves.toEqual({
      agent: "claude",
      status: "error",
      output: "",
      error: "Process timed out after 10 ms",
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
    await expect(promise).resolves.toMatchObject({ status: "error", error: "Request was aborted" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(audits).toEqual(["os_sandbox_created", "os_sandbox_process_cleanup"]);
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
