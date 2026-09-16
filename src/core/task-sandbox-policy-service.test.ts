import { describe, expect, it, vi } from "vitest";
import type { RuntimePolicy } from "../runtime/types";
import type { PublicOsSandboxPolicy } from "../server/os-sandbox";
import { type RepoTask } from "../server/tasks";
import {
  createTaskSandboxPolicyService,
  TaskSandboxPolicyNotFoundError,
  TaskSandboxPolicyUnavailableError,
} from "./task-sandbox-policy-service";

const task = { id: "task-1" } as RepoTask;
const validationPolicy = { status: "enforced", profile: "validation" } as PublicOsSandboxPolicy;
const agentPolicy = { status: "enforced", profile: "agent_read_only" } as PublicOsSandboxPolicy;
const policies = {
  codex: { agent: "codex", role: "review_only", osSandboxProfile: "agent_read_only" },
  cursor: { agent: "cursor", role: "disabled", osSandboxProfile: "agent_read_only" },
  claude: { agent: "claude", role: "implement", osSandboxProfile: "agent_implement" },
} as unknown as Record<string, RuntimePolicy>;

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  get: (id: string) => RepoTask | undefined;
  buildPolicies: (value: RepoTask) => Promise<typeof policies>;
  toPublic: (profile: string) => PublicOsSandboxPolicy;
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    get: vi.fn(() => task),
    buildPolicies: vi.fn(async () => policies),
    toPublic: vi.fn((profile: string) => (
      profile === "validation" ? validationPolicy : agentPolicy
    )),
    ...overrides,
  };
}

describe("task sandbox policy service", () => {
  it("initializes recovery before lookup and reports a missing task", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      get: vi.fn(() => { calls.push("get"); return undefined; }),
    });
    const service = createTaskSandboxPolicyService(
      deps as unknown as Parameters<typeof createTaskSandboxPolicyService>[0],
    );

    await expect(service.load("missing")).rejects.toBeInstanceOf(
      TaskSandboxPolicyNotFoundError,
    );
    expect(calls).toEqual(["recovery", "get"]);
    expect(deps.buildPolicies).not.toHaveBeenCalled();
  });

  it("projects enforced sandbox policy and omits disabled agents", async () => {
    const deps = dependencies();
    const service = createTaskSandboxPolicyService(
      deps as unknown as Parameters<typeof createTaskSandboxPolicyService>[0],
    );

    await expect(service.load(task.id)).resolves.toEqual({
      status: "enforced",
      validation: validationPolicy,
      agents: [
        { agent: "codex", ...agentPolicy },
        { agent: "claude", ...agentPolicy },
      ],
    });
    expect(deps.buildPolicies).toHaveBeenCalledWith(task);
    expect(deps.toPublic).toHaveBeenCalledWith("validation");
    expect(deps.toPublic).toHaveBeenCalledWith("agent_read_only");
    expect(deps.toPublic).toHaveBeenCalledWith("agent_implement");
  });

  it("maps policy build failures to TaskSandboxPolicyUnavailableError", async () => {
    const deps = dependencies({
      buildPolicies: vi.fn(async () => {
        throw new Error("Runtime policy snapshot repository mismatch");
      }),
    });
    const service = createTaskSandboxPolicyService(
      deps as unknown as Parameters<typeof createTaskSandboxPolicyService>[0],
    );

    await expect(service.load(task.id)).rejects.toMatchObject({
      name: "TaskSandboxPolicyUnavailableError",
      message: "Runtime policy snapshot repository mismatch",
    });
    await expect(service.load(task.id)).rejects.toBeInstanceOf(
      TaskSandboxPolicyUnavailableError,
    );
  });
});
