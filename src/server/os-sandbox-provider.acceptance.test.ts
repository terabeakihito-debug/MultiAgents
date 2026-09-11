import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeAgent } from "../agents/claude";
import { codexAgent } from "../agents/codex";
import { cursorAgent } from "../agents/cursor";
import { buildGenericRuntimePolicy } from "./runtime-policy";
import { runGit } from "./git";

const enabled = process.env.MULTIAGENTS_PROVIDER_ACCEPTANCE === "1";
const cursorLifecycleEnabled = process.env.MULTIAGENTS_CURSOR_LIFECYCLE_ACCEPTANCE === "1";

describe.runIf(enabled)("Phase 18 provider authentication acceptance", () => {
  let worktree: string;
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "multiagents-provider-base-"));
    worktree = `${base}-worktree`;
    await runGit(base, ["init", "-b", "main"]);
    await runGit(base, ["config", "user.email", "phase18@example.com"]);
    await runGit(base, ["config", "user.name", "Phase 18"]);
    await writeFile(join(base, "README.md"), "provider acceptance\n");
    await writeFile(join(base, "package.json"), "{\"name\":\"provider-acceptance\"}\n");
    await runGit(base, ["add", "README.md", "package.json"]);
    await runGit(base, ["commit", "-m", "acceptance fixture"]);
    await runGit(base, ["worktree", "add", "-b", "phase18-provider", worktree, "HEAD"]);
  });
  afterAll(async () => { await Promise.all([worktree, base].filter(Boolean).map((path) => rm(path, { recursive: true, force: true }))); });

  it("runs the Codex read-only repository-access diagnostic fixture in the production outer sandbox", async () => {
    const result = await codexAgent.run(
      "Run pwd, then run head -n 1 package.json. Do not modify anything. Report the exact tool error if either command fails.",
      { policy: buildGenericRuntimePolicy("codex", worktree) },
    );
    // Deliberately inspect only the execution classification: provider stdout
    // can contain repository-derived text and must not be logged by a test.
    expect(result.status).toBe("completed");
  }, 180_000);

  it("runs Codex with its minimal credential mount and writes only the task worktree", async () => {
    const generic = buildGenericRuntimePolicy("codex", worktree);
    const policy = {
      ...generic,
      role: "implement" as const,
      policyClass: "repository_implementation" as const,
      filesystem: ["worktree_read" as const, "worktree_write" as const],
      allowWrite: true,
      writableRoot: worktree,
      baseRepoRoot: base,
      source: "task_snapshots" as const,
      osSandboxProfile: "agent_implement" as const,
    };
    const result = await codexAgent.run("Create phase18-provider-ok.txt in the current project containing exactly OK followed by a newline. Do nothing else.", { policy });
    if (result.status === "error") throw new Error(result.error ?? "Codex acceptance failed");
    expect(result).toMatchObject({ status: "completed" });
    expect(await readFile(join(worktree, "phase18-provider-ok.txt"), "utf8")).toBe("OK\n");
  }, 180_000);

  it("runs Cursor review with only its credential file", async () => {
    const result = await cursorAgent.run("Reply with exactly CURSOR_PHASE18_OK", { policy: buildGenericRuntimePolicy("cursor", worktree) });
    expect(result).toMatchObject({ status: "completed" });
    expect(result.output).toContain("CURSOR_PHASE18_OK");
  }, 180_000);

  it.runIf(cursorLifecycleEnabled)("captures content-free lifecycle telemetry for a production Cursor review", async () => {
    const prompt = "Review README.md for one correctness or safety concern. Do not modify files, run Git mutations, or reveal file contents verbatim.";
    const telemetry: import("../agents/types").AgentLifecycleTelemetry[] = [];
    const result = await cursorAgent.run(prompt, {
      policy: buildGenericRuntimePolicy("cursor", worktree),
      onLifecycleTelemetry: (value) => { telemetry.push(value); },
    });
    // This is deliberately a successful-review probe: it exercises the real
    // outer-bwrap + immutable-binding path without printing provider output.
    expect(result.status).toBe("completed");
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({ stdoutBytes: expect.any(Number), stderrBytes: expect.any(Number), spawnedAt: expect.any(String), childClosedAt: expect.any(String), exitCode: 0 });
    expect(telemetry[0].stdoutBytes).toBeGreaterThan(0);
    expect(telemetry[0].stdoutFirstByteAt).toMatch(/^\d{4}-/);
    expect(telemetry[0].stdoutLastByteAt).toMatch(/^\d{4}-/);
    if (telemetry[0].stderrBytes > 0) {
      expect(telemetry[0].stderrFirstByteAt).toMatch(/^\d{4}-/);
      expect(telemetry[0].stderrLastByteAt).toMatch(/^\d{4}-/);
    } else {
      expect(telemetry[0].stderrFirstByteAt).toBeUndefined();
      expect(telemetry[0].stderrLastByteAt).toBeUndefined();
    }
    expect(telemetry[0]).toMatchObject({ terminationReason: undefined, terminationMethod: undefined, timeoutRequestedAt: undefined, sigtermRequestedAt: undefined, sigtermSentAt: undefined, sigkillRequestedAt: undefined, sigkillSentAt: undefined, exitSignal: undefined });
    expect(JSON.stringify(telemetry[0])).not.toContain(prompt);
    expect(JSON.stringify(telemetry[0])).not.toContain("README.md");
  }, 180_000);

  it("runs Claude review with only its minimal credential file", async () => {
    const result = await claudeAgent.run("Reply with exactly CLAUDE_PHASE18_OK", { policy: buildGenericRuntimePolicy("claude", worktree) });
    expect(result).toMatchObject({ status: "completed" });
    expect(result.output).toContain("CLAUDE_PHASE18_OK");
  }, 180_000);
});
