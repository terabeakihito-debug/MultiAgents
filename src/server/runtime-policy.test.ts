import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentId } from "../agents/types";
import { buildChildProcessEnv } from "./child-process-env";
import { prepareApproval } from "./pull-request";
import { buildGenericRuntimePolicy, buildTaskRuntimePolicies, publicRuntimePolicy, runTaskAgentWithPolicy, RuntimePolicyError } from "./runtime-policy";
import { prepareTaskRuntime } from "./task-runtime";
import { clearTasksForTests, createTask, getTaskHistory, reloadTasksFromStoreForTests, resumeTask } from "./tasks";
import { runGit } from "./git";

async function fixture(templateId = "bug_fix") {
  const allowedRoot = await mkdtemp(join(tmpdir(), "multiagents-runtime-repos-"));
  const worktreeRoot = await mkdtemp(join(tmpdir(), "multiagents-runtime-worktrees-"));
  const repoPath = join(allowedRoot, "project");
  await mkdir(repoPath);
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "runtime@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Runtime Test"]);
  await writeFile(join(repoPath, "README.md"), "initial\n");
  await runGit(repoPath, ["add", "README.md"]);
  await runGit(repoPath, ["commit", "-m", "initial"]);
  await runGit(repoPath, ["remote", "add", "origin", "https://github.com/example/runtime-policy.git"]);
  const task = await createTask("project", { allowedRoot, worktreeRoot, templateId, prompt: "test runtime policy" });
  return { task, repoPath, allowedRoot, worktreeRoot };
}

function adapter(id: AgentId, action: () => Promise<void>): AgentAdapter {
  return { id, name: id, run: async () => { await action(); return { agent: id, status: "completed", output: "done" }; } };
}

afterEach(() => clearTasksForTests());

describe("Phase 17 runtime capability policy", () => {
  it("constructs Codex implement and Cursor/Claude review policies from snapshots deterministically", async () => {
    const { task } = await fixture();
    const first = await buildTaskRuntimePolicies(task);
    const second = await buildTaskRuntimePolicies(task);
    expect(first.codex).toMatchObject({ version: 2, role: "implement", allowWrite: true, writableRoot: task.worktreePath, filesystem: ["worktree_read", "worktree_write"], environmentPolicy: "agent", osSandboxProfile: "agent_implement" });
    expect(first.cursor).toMatchObject({ role: "review_only", allowWrite: false, filesystem: ["worktree_read"] });
    expect(first.claude).toMatchObject({ role: "review_only", allowWrite: false, filesystem: ["worktree_read"] });
    expect(Object.values(first).map((policy) => policy.policyHash)).toEqual(Object.values(second).map((policy) => policy.policyHash));
  });

  it("gives Documentation Claude a review-only execution policy", async () => {
    const { task } = await fixture("documentation");
    const policies = await buildTaskRuntimePolicies(task);
    expect(policies.claude).toMatchObject({ role: "review_only", allowWrite: false, filesystem: ["worktree_read"] });
  });

  it.each(["security_review", "investigation"])("makes %s fully read-only without a worktree", async (templateId) => {
    const { task, repoPath } = await fixture(templateId);
    const policies = await buildTaskRuntimePolicies(task);
    expect(task.worktreeAvailable).toBe(false);
    expect(Object.values(policies).every((policy) => !policy.allowWrite && policy.workingRoot === repoPath)).toBe(true);
  });

  it("keeps generic Parallel agents read-only", () => {
    for (const id of ["codex", "cursor", "claude"] as const) expect(buildGenericRuntimePolicy(id, "/workspace")).toMatchObject({ role: "review_only", allowWrite: false, policyClass: "generic_read_only" });
  });

  it("never exposes a writable root or absolute working path through the public policy", async () => {
    const { task } = await fixture();
    const policy = publicRuntimePolicy((await buildTaskRuntimePolicies(task)).codex);
    const serialized = JSON.stringify(policy);
    expect(policy.writeScope).toBe("task_worktree_only");
    expect(serialized).not.toContain(task.worktreePath);
    expect(serialized).not.toContain(task.repoPath);
    expect(policy).not.toHaveProperty("writableRoot");
    expect(policy).not.toHaveProperty("workingRoot");
  });

  it("rejects a base repository as the writable worktree", async () => {
    const { task, repoPath } = await fixture();
    task.worktreePath = repoPath;
    await expect(buildTaskRuntimePolicies(task)).rejects.toBeInstanceOf(RuntimePolicyError);
  });

  it("rejects the wrong managed worktree root", async () => {
    const { task } = await fixture();
    task.worktreeRoot = "/tmp";
    await expect(buildTaskRuntimePolicies(task)).rejects.toBeInstanceOf(RuntimePolicyError);
  });

  it("rejects a repository path outside its allowed root", async () => {
    const { task } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "multiagents-outside-"));
    task.repoPath = outside;
    await expect(buildTaskRuntimePolicies(task)).rejects.toThrow("Saved repository root");
  });

  it("rejects a symlink path that resolves outside the managed task path", async () => {
    const { task, repoPath } = await fixture();
    const aliasRoot = await mkdtemp(join(tmpdir(), "multiagents-runtime-alias-"));
    const alias = join(aliasRoot, "escape");
    await symlink(repoPath, alias);
    task.worktreePath = alias;
    await expect(buildTaskRuntimePolicies(task)).rejects.toBeInstanceOf(RuntimePolicyError);
  });

  it("rejects Windows mounted-drive roots before runtime execution", async () => {
    const { task } = await fixture();
    task.allowedRoot = "/mnt/c";
    await expect(buildTaskRuntimePolicies(task)).rejects.toThrow();
  });

  it("preserves HOME but excludes the Slack secret in the policy-integrated agent environment", () => {
    const env = buildChildProcessEnv({ purpose: "agent", baseEnv: { HOME: "/home/test", PATH: "/usr/bin", MULTIAGENTS_SLACK_WEBHOOK_URL: "TEST_SECRET_DO_NOT_LEAK" } });
    expect(env.HOME).toBe("/home/test");
    expect(env.MULTIAGENTS_SLACK_WEBHOOK_URL).toBeUndefined();
  });

  it("detects a reviewer write, requires attention, audits it, and blocks approval", async () => {
    const { task, allowedRoot, worktreeRoot } = await fixture();
    const runtime = await prepareTaskRuntime(task);
    const reviewer = adapter("cursor", () => writeFile(join(task.worktreePath, "reviewer-write.txt"), "forbidden\n"));
    const result = await runtime.execute(reviewer, "review", undefined, "cursor_review");
    expect(result).toMatchObject({ status: "error", runtimeViolation: "unexpected_write" });
    expect(task).toMatchObject({ recoveryStatus: "needs_attention", reviewReady: false, runtimeViolation: { type: "unexpected_write", agent: "cursor" } });
    expect(getTaskHistory(task.id).events.map((event) => event.type)).toEqual(expect.arrayContaining(["runtime_policy_created", "runtime_execution_started", "runtime_execution_completed", "runtime_violation_detected"]));
    await expect(prepareApproval(task)).rejects.toThrow("Runtime policy violation");
    reloadTasksFromStoreForTests();
    const restored = await resumeTask(task.id, { allowedRoot, worktreeRoot });
    expect(restored).toMatchObject({ recoveryStatus: "needs_attention", runtimeViolation: { type: "unexpected_write" } });
  });

  it("keeps a runtime violation authoritative when its final audit fails", async () => {
    const { task } = await fixture();
    const policy = (await buildTaskRuntimePolicies(task)).cursor;
    const result = await runTaskAgentWithPolicy({
      task,
      policy,
      prompt: "review",
      adapter: {
        id: "cursor", name: "cursor", supportsPostCloseFinalization: true,
        run: async (_prompt, options) => {
          await writeFile(join(task.worktreePath, "forbidden.txt"), "write\n");
          return options!.afterClose!({ agent: "cursor", status: "completed", output: "done" });
        },
      },
      onAudit: (type) => { if (type === "runtime_violation_detected") throw new Error("audit persistence failed"); },
      onViolation: () => undefined,
      onSandboxAudit: () => undefined,
    });
    expect(result).toMatchObject({ status: "error", runtimeViolation: "unexpected_write" });
  });

  it("warns when successful Codex output self-reports repository access failure with no implementation diff", async () => {
    const { task } = await fixture();
    const policy = (await buildTaskRuntimePolicies(task)).codex;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await runTaskAgentWithPolicy({
        task,
        policy,
        prompt: "implement",
        adapter: { id: "codex", name: "codex", run: async () => ({ agent: "codex", status: "completed", output: "実行環境のエラーにより、ファイルの確認・編集ができませんでした" }) },
        onAudit: () => undefined,
        onViolation: () => undefined,
        onSandboxAudit: () => undefined,
      });
      expect(result.status).toBe("completed");
      expect(warn).toHaveBeenCalledWith("codex_repository_access_self_report", expect.stringContaining('"implementationDiffEmpty":true'));
    } finally {
      warn.mockRestore();
    }
  });

  it("persists only safe OS sandbox lifecycle metadata", async () => {
    const { task } = await fixture();
    const runtime = await prepareTaskRuntime(task);
    const sandboxed: AgentAdapter = {
      id: "cursor", name: "cursor",
      run: async (_prompt, options) => {
        options?.onSandboxAudit?.({ type: "os_sandbox_created", profile: "agent_read_only", provider: "cursor", capabilityClass: "repository_review" });
        options?.onSandboxAudit?.({ type: "os_sandbox_process_cleanup", profile: "agent_read_only", provider: "cursor", capabilityClass: "repository_review" });
        return { agent: "cursor", status: "completed", output: "done" };
      },
    };
    await runtime.execute(sandboxed, "review", undefined, "cursor_review");
    const events = getTaskHistory(task.id).events.filter((event) => event.type.startsWith("os_sandbox_"));
    expect(events.map((event) => event.type)).toEqual(["os_sandbox_created", "os_sandbox_process_cleanup"]);
    expect(events[0].metadata).toEqual({ agent: "cursor", sandboxProfile: "agent_read_only", capabilityClass: "repository_review" });
    expect(JSON.stringify(events)).not.toContain(task.worktreePath);
  });

  it("detects base repository mutation by an implement agent", async () => {
    const { task, repoPath } = await fixture();
    const runtime = await prepareTaskRuntime(task);
    const result = await runtime.execute(adapter("codex", () => writeFile(join(repoPath, "base-write.txt"), "forbidden\n")), "implement", undefined, "codex_draft");
    expect(result.runtimeViolation).toBe("base_repo_changed");
  });

  it("detects mutation of a sibling repository under the allowed root", async () => {
    const { task, allowedRoot } = await fixture();
    const sibling = join(allowedRoot, "sibling");
    await mkdir(sibling);
    await runGit(sibling, ["init", "-b", "main"]);
    await runGit(sibling, ["config", "user.email", "runtime@example.com"]);
    await runGit(sibling, ["config", "user.name", "Runtime Test"]);
    await writeFile(join(sibling, "README.md"), "sibling\n");
    await runGit(sibling, ["add", "README.md"]);
    await runGit(sibling, ["commit", "-m", "initial"]);
    const runtime = await prepareTaskRuntime(task);
    const result = await runtime.execute(adapter("codex", () => writeFile(join(sibling, "escape.txt"), "forbidden\n")), "implement", undefined, "codex_draft");
    expect(result.runtimeViolation).toBe("unexpected_write");
  });

  it("detects an Agent-created commit through HEAD change", async () => {
    const { task } = await fixture();
    const runtime = await prepareTaskRuntime(task);
    const result = await runtime.execute(adapter("codex", async () => {
      await writeFile(join(task.worktreePath, "agent-commit.txt"), "forbidden\n");
      await runGit(task.worktreePath, ["add", "agent-commit.txt"]);
      await runGit(task.worktreePath, ["commit", "-m", "forbidden agent commit"]);
    }), "implement", undefined, "codex_draft");
    expect(result.runtimeViolation).toBe("head_changed");
  });

  it("detects an Agent branch change", async () => {
    const { task } = await fixture();
    const runtime = await prepareTaskRuntime(task);
    const result = await runtime.execute(adapter("codex", async () => { await runGit(task.worktreePath, ["switch", "-c", "forbidden-agent-branch"]); }), "implement", undefined, "codex_draft");
    expect(result.runtimeViolation).toBe("branch_changed");
  });

  it("rejects profile role escalation for a reviewer", async () => {
    const { task } = await fixture();
    task.profile = { ...task.profile!, roles: { ...task.profile!.roles, cursor: "implement" } };
    await expect(buildTaskRuntimePolicies(task)).rejects.toThrow("Cursor".toLowerCase());
  });
});
