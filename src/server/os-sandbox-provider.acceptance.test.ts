import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents } from "../agents";
import { claudeAgent } from "../agents/claude";
import { codexAgent } from "../agents/codex";
import { cursorAgent } from "../agents/cursor";
import { MAX_FLOW_MS, reviewStepActualBudgetMs, runReviewFlow } from "../flows/review";
import { withRuntimeBindingRootForTests } from "./immutable-executable-binding";
import { runGit } from "./git";
import { createDiffSnapshot } from "./pull-request";
import { providerDiagnostics } from "./provider-diagnostics";
import { buildGenericRuntimePolicy } from "./runtime-policy";
import { StateStore, replaceStateStoreForTests } from "./state-store";
import { prepareTaskRuntime, taskRuntimeExecutor } from "./task-runtime";
import { beginTaskReview, clearTasksForTests, completeTaskReview, createTask, executionPromptForTask, executionRootForTask, getTaskDiff, getTaskHistory, recordFlowEvent } from "./tasks";

const enabled = process.env.MULTIAGENTS_PROVIDER_ACCEPTANCE === "1";
const cursorLifecycleEnabled = process.env.MULTIAGENTS_CURSOR_LIFECYCLE_ACCEPTANCE === "1";
const fullReviewEnabled = enabled && process.env.MULTIAGENTS_FULL_REVIEW_ACCEPTANCE === "1";

function requireAvailableFullReviewProviders(diagnostics: Awaited<ReturnType<typeof providerDiagnostics>>) {
  const unavailable = diagnostics.filter((diagnostic) => diagnostic.status === "missing" || diagnostic.status === "credential_unavailable");
  if (unavailable.length) throw new Error(`Full provider review acceptance unavailable: ${unavailable.map((diagnostic) => diagnostic.provider).join(",")}`);
}

describe("Phase 18 full provider review acceptance gate", () => {
  it("fails an opted-in full review when diagnostics report an unavailable provider", () => {
    const diagnostics = [{ provider: "claude", status: "credential_unavailable" }] as Awaited<ReturnType<typeof providerDiagnostics>>;
    expect(() => requireAvailableFullReviewProviders(diagnostics)).toThrow("claude");
  });
});

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

  it.runIf(fullReviewEnabled)("runs the complete production review flow with all three real providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-provider-full-review-"));
    const suppressProviderDiagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const allowedRoot = join(root, "projects");
    const repoPath = join(allowedRoot, "provider-review");
    const worktreeRoot = join(root, "worktrees");
    replaceStateStoreForTests(new StateStore(join(root, "state.db")));
    clearTasksForTests();
    try {
      await mkdir(repoPath, { recursive: true });
      await runGit(repoPath, ["init", "-b", "main"]);
      await runGit(repoPath, ["config", "user.email", "provider-flow@example.com"]);
      await runGit(repoPath, ["config", "user.name", "Provider Flow Acceptance"]);
      await writeFile(join(repoPath, "README.md"), "Synthetic provider review fixture.\n");
      await runGit(repoPath, ["add", "README.md"]);
      await runGit(repoPath, ["commit", "-m", "provider review fixture"]);
      await runGit(repoPath, ["remote", "add", "origin", "https://github.com/example/provider-review.git"]);

      const task = await createTask("provider-review", {
        allowedRoot,
        worktreeRoot,
        templateId: "bug_fix",
        prompt: "Review the synthetic task and return a concise result. Do not commit, push, create a pull request, or access credentials.",
      });
      const diagnostics = await providerDiagnostics({ cwd: task.worktreePath, force: true });
      requireAvailableFullReviewProviders(diagnostics);
      for (const diagnostic of diagnostics) {
        expect(["supported", "supported_with_warning"]).toContain(diagnostic.status);
      }

      const prompt = task.prompt;
      beginTaskReview(task, prompt);
      const startedAt = Date.now();
      const result = await withRuntimeBindingRootForTests(join(root, "provider-bindings"), async () => {
        const runtime = await prepareTaskRuntime(task);
        expect(runtime.policies.codex).toMatchObject({ role: "implement", allowWrite: true, osSandboxProfile: "agent_implement" });
        expect(runtime.policies.cursor).toMatchObject({ role: "review_only", allowWrite: false, osSandboxProfile: "agent_read_only" });
        expect(runtime.policies.claude).toMatchObject({ role: "review_only", allowWrite: false, osSandboxProfile: "agent_read_only" });
        return runReviewFlow(executionPromptForTask(task, prompt), {
          cwd: executionRootForTask(task),
          roles: task.template!.roles,
          repositoryReadOnly: task.template!.readOnly,
          runtimePolicies: runtime.policies,
          executeAgent: taskRuntimeExecutor(runtime, agents),
          fingerprint: async () => (await createDiffSnapshot(task)).hash,
          getDiff: async () => {
            const diff = await getTaskDiff(task);
            return [diff.patch, diff.untrackedPatch].filter(Boolean).join("\n\n");
          },
          onEvent: (event) => recordFlowEvent(task, event),
        });
      });
      const totalDurationMs = Date.now() - startedAt;
      const failures = result.steps
        .filter((step) => step.status !== "completed")
        .map((step) => `${step.id}:${step.status}:${step.durationMs ?? 0}:${step.terminationReason ?? "none"}`);
      if (result.status !== "completed" || failures.length) {
        throw new Error(`Provider full review flow failed (${failures.join(",") || "flow_not_completed"})`);
      }
      expect(result.steps.map((step) => step.id)).toEqual(["codex_draft", "cursor_review", "claude_review", "codex_final"]);
      expect(result.finalOutput.length).toBeGreaterThan(0);
      expect(totalDurationMs).toBeLessThan(MAX_FLOW_MS);

      const lifecycle = getTaskHistory(task.id).events.filter((event) => event.type === "agent_lifecycle_recorded");
      expect(lifecycle.map((event) => event.stepId)).toEqual(["codex_draft", "cursor_review", "claude_review", "codex_final"]);
      const flowStartedAt = Math.min(...result.steps.map((step) => Date.parse(step.startedAt!)));
      const stepTelemetry: Array<{ stepId: string; provider: string; durationMs: number; workDurationMs: number; workBudgetMs: number; terminationReason?: string; spawnedAt: string; childClosedAt: string }> = [];
      for (const step of result.steps) {
        const entry = lifecycle.find((event) => event.stepId === step.id);
        const telemetry = entry?.metadata?.lifecycle;
        if (!telemetry?.childClosedAt || !step.startedAt) throw new Error(`Provider lifecycle metadata missing for ${step.id}`);
        const workDurationMs = Date.parse(telemetry.childClosedAt) - Date.parse(step.startedAt);
        const budgetMs = reviewStepActualBudgetMs(step.id, flowStartedAt + MAX_FLOW_MS, Date.parse(step.startedAt));
        if (workDurationMs < 0 || workDurationMs > budgetMs) {
          throw new Error(`Provider step work budget failed (${step.id}:${workDurationMs}:${budgetMs}:${telemetry.terminationReason ?? "none"})`);
        }
        expect(telemetry.terminationReason).toBeUndefined();
        expect(telemetry.exitSignal).toBeUndefined();
        stepTelemetry.push({
          stepId: step.id,
          provider: step.agent,
          durationMs: step.durationMs ?? 0,
          workDurationMs,
          workBudgetMs: budgetMs,
          terminationReason: telemetry.terminationReason,
          spawnedAt: telemetry.spawnedAt,
          childClosedAt: telemetry.childClosedAt,
        });
      }
      completeTaskReview(task, result.steps[3]?.status === "completed");
      expect(task).toMatchObject({ status: "awaiting_approval", reviewReady: true, flowStatus: "completed" });
      console.info("provider_full_review_acceptance", JSON.stringify({ status: result.status, totalDurationMs, steps: stepTelemetry }));
    } finally {
      suppressProviderDiagnostics.mockRestore();
      clearTasksForTests();
      replaceStateStoreForTests(new StateStore(":memory:"));
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
