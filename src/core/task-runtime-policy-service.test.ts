import { describe, expect, it, vi } from "vitest";
import { RUNTIME_POLICY_VERSION, type RuntimePolicy } from "../runtime/types";
import type { PublicOsSandboxPolicy } from "../server/os-sandbox";
import { type RepoTask } from "../server/tasks";
import {
  createTaskRuntimePolicyService,
  TASK_RUNTIME_NETWORK_ENFORCEMENT_DESCRIPTION,
  TaskRuntimePolicyNotFoundError,
  TaskRuntimePolicyUnavailableError,
} from "./task-runtime-policy-service";

const task = { id: "task-1" } as RepoTask;
const template = {
  taskType: "bug_fix" as const,
  readOnly: false,
  requireWorktree: true,
};
const sandbox = { status: "enforced", profile: "validation" } as PublicOsSandboxPolicy;
const publicPolicy = { agent: "codex", role: "review_only" };
const policies = {
  codex: { agent: "codex", role: "review_only", osSandboxProfile: "agent_read_only" },
  cursor: { agent: "cursor", role: "disabled", osSandboxProfile: "agent_read_only" },
} as unknown as Record<string, RuntimePolicy>;

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  requireTemplate: (value: RepoTask) => typeof template;
  buildPolicies: (value: RepoTask) => Promise<typeof policies>;
  toPublicSandbox: (profile: string) => PublicOsSandboxPolicy;
  toPublicPolicy: (policy: RuntimePolicy) => typeof publicPolicy;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => task),
    requireTemplate: vi.fn(() => template),
    buildPolicies: vi.fn(async () => policies),
    toPublicSandbox: vi.fn(() => sandbox),
    toPublicPolicy: vi.fn(() => publicPolicy),
    ...overrides,
  };
}

describe("task runtime policy service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createTaskRuntimePolicyService(
      deps as unknown as Parameters<typeof createTaskRuntimePolicyService>[0],
    );

    await expect(service.load("missing")).rejects.toBeInstanceOf(
      TaskRuntimePolicyNotFoundError,
    );
    expect(calls).toEqual(["recovery", "get"]);
    expect(deps.requireTemplate).not.toHaveBeenCalled();
    expect(deps.buildPolicies).not.toHaveBeenCalled();
  });

  it("projects runtime policy, omits disabled sandbox agents, and keeps disabled policies", async () => {
    const deps = dependencies();
    const service = createTaskRuntimePolicyService(
      deps as unknown as Parameters<typeof createTaskRuntimePolicyService>[0],
    );

    await expect(service.load(task.id)).resolves.toEqual({
      runtimePolicyVersion: RUNTIME_POLICY_VERSION,
      taskType: "bug_fix",
      allAgentsReadOnly: false,
      worktreeRequired: true,
      networkEnforcementDescription: TASK_RUNTIME_NETWORK_ENFORCEMENT_DESCRIPTION,
      osSandbox: {
        status: "enforced",
        validation: sandbox,
        agents: [{ agent: "codex", ...sandbox }],
      },
      policies: [publicPolicy, publicPolicy],
    });
    expect(deps.requireTemplate).toHaveBeenCalledWith(task);
    expect(deps.buildPolicies).toHaveBeenCalledWith(task);
    expect(deps.toPublicPolicy).toHaveBeenCalledTimes(2);
  });

  it("maps template and policy failures to TaskRuntimePolicyUnavailableError", async () => {
    const deps = dependencies({
      requireTemplate: vi.fn(() => {
        throw new Error("Task template snapshot is inconsistent. Human attention is required.");
      }),
    });
    const service = createTaskRuntimePolicyService(
      deps as unknown as Parameters<typeof createTaskRuntimePolicyService>[0],
    );

    await expect(service.load(task.id)).rejects.toMatchObject({
      name: "TaskRuntimePolicyUnavailableError",
      message: "Task template snapshot is inconsistent. Human attention is required.",
    });
    await expect(service.load(task.id)).rejects.toBeInstanceOf(
      TaskRuntimePolicyUnavailableError,
    );
  });
});
