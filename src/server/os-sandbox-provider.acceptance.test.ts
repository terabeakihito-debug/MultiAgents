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
    await runGit(base, ["add", "README.md"]);
    await runGit(base, ["commit", "-m", "acceptance fixture"]);
    await runGit(base, ["worktree", "add", "-b", "phase18-provider", worktree, "HEAD"]);
  });
  afterAll(async () => { await Promise.all([worktree, base].filter(Boolean).map((path) => rm(path, { recursive: true, force: true }))); });

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

  it("runs Claude review with only its minimal credential file", async () => {
    const result = await claudeAgent.run("Reply with exactly CLAUDE_PHASE18_OK", { policy: buildGenericRuntimePolicy("claude", worktree) });
    expect(result).toMatchObject({ status: "completed" });
    expect(result.output).toContain("CLAUDE_PHASE18_OK");
  }, 180_000);
});
