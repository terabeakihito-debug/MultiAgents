import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createAgentAdapter } from "./runner";

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
      { cwd: "/workspace", spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("hello; touch /tmp/nope");
    child.stdout.write("CODEX_OK\n");
    child.emit("close", 0, null);
    await expect(promise).resolves.toEqual({ agent: "codex", status: "completed", output: "CODEX_OK" });
    expect(spawnProcess).toHaveBeenCalledWith(
      "codex",
      ["exec", "--cd", "/workspace", "hello; touch /tmp/nope"],
      expect.objectContaining({ cwd: "/workspace", shell: false }),
    );
  });

  it("passes an adapter-specific environment and absolute binary unchanged", async () => {
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
        binary: "/home/testuser/.local/bin/claude",
        args: (prompt) => ["-p", prompt],
      },
      { cwd: "/workspace", env, spawnProcess: spawnProcess as never },
    );
    const promise = adapter.run("Reply with exactly: CLAUDE_OK");
    child.stdout.write("CLAUDE_OK\n");
    child.emit("close", 0, null);
    await expect(promise).resolves.toEqual({ agent: "claude", status: "completed", output: "CLAUDE_OK" });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/home/testuser/.local/bin/claude",
      ["-p", "Reply with exactly: CLAUDE_OK"],
      expect.objectContaining({ cwd: "/workspace", env, shell: false }),
    );
  });

  it("returns an agent-scoped error without throwing", async () => {
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "cursor", name: "Cursor", binary: "cursor-agent", args: (prompt) => ["-p", prompt] },
      { spawnProcess: vi.fn(() => child) as never },
    );
    const promise = adapter.run("test");
    child.stderr.write("authentication failed");
    child.emit("close", 1, null);
    await expect(promise).resolves.toEqual({ agent: "cursor", status: "error", output: "", error: "Process exited with code 1: authentication failed" });
  });

  it("terminates a timed-out process", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "claude", name: "Claude", binary: "claude", args: (prompt) => ["-p", prompt] },
      { timeoutMs: 10, spawnProcess: vi.fn(() => child) as never },
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

  it("caps output by bytes without splitting a UTF-8 character", async () => {
    const child = fakeChild();
    const adapter = createAgentAdapter(
      { id: "codex", name: "Codex", binary: "codex", args: (prompt) => ["exec", prompt] },
      { spawnProcess: vi.fn(() => child) as never },
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
