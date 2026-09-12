import { describe, expect, it, vi } from "vitest";
import type { RepoTask } from "@/server/tasks";

const mocks = vi.hoisted(() => ({
  initializeTaskRecovery: vi.fn(async () => undefined),
  getTask: vi.fn(),
  requireHumanMutation: vi.fn(() => undefined),
}));

vi.mock("@/server/tasks", () => ({ initializeTaskRecovery: mocks.initializeTaskRecovery, getTask: mocks.getTask }));
vi.mock("@/server/request-security", () => ({ requireHumanMutation: mocks.requireHumanMutation }));

import { POST } from "./route";

function task(overrides: Partial<RepoTask> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    worktreePath: "/managed/worktree with spaces/'quoted'",
    dependencyRecovery: "dependency_setup_required",
    recoveryStatus: "recoverable",
    worktreeAvailable: true,
    worktreeStatus: "available",
    ...overrides,
  } as RepoTask;
}

describe("POST /api/tasks/[id]/dependency-recovery-instructions", () => {
  it("returns setup instructions only after the endpoint is explicitly requested", async () => {
    mocks.getTask.mockReturnValue(task());
    const response = await POST(new Request("http://localhost:3000/api/tasks/11111111-1111-4111-8111-111111111111/dependency-recovery-instructions", { method: "POST" }), { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ command: "cd -- '/managed/worktree with spaces/'\\''quoted'\\''' && npm install" });
    expect(mocks.initializeTaskRecovery).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    task({ dependencyRecovery: undefined }),
    task({ recoveryStatus: "orphaned", worktreeAvailable: false, worktreeStatus: "missing" }),
    task({ recoveryStatus: "invalid", worktreeAvailable: false, worktreeStatus: "invalid" }),
  ])("returns 404/409 instead of exposing a command for non-recoverable state", async (value) => {
    mocks.getTask.mockReturnValue(value);
    const response = await POST(new Request("http://localhost:3000/api/tasks/id/dependency-recovery-instructions", { method: "POST" }), { params: Promise.resolve({ id: "id" }) });
    expect([404, 409]).toContain(response.status);
    expect(JSON.stringify(await response.json())).not.toContain("/managed/");
  });
});
