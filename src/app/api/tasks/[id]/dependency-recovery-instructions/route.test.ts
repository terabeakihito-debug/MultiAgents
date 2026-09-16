import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  requireHumanMutation: vi.fn(),
}));

vi.mock("../../../../../core/dependency-recovery-service", () => {
  class DependencyRecoveryTaskNotFoundError extends Error {
    constructor() {
      super("Task not found");
      this.name = "DependencyRecoveryTaskNotFoundError";
    }
  }

  class DependencyRecoveryUnavailableError extends Error {
    constructor() {
      super("Dependency recovery instructions are unavailable for this task");
      this.name = "DependencyRecoveryUnavailableError";
    }
  }

  return {
    dependencyRecoveryService: {
      load: mocks.load,
    },
    DependencyRecoveryTaskNotFoundError,
    DependencyRecoveryUnavailableError,
  };
});

vi.mock("@/server/request-security", () => ({
  requireHumanMutation: mocks.requireHumanMutation,
}));

import {
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
} from "../../../../../core/dependency-recovery-service";
import { POST } from "./route";

describe("POST /api/tasks/[id]/dependency-recovery-instructions", () => {
  beforeEach(() => {
    mocks.load.mockReset();
    mocks.requireHumanMutation.mockReset();
    mocks.requireHumanMutation.mockReturnValue(undefined);
  });

  it("returns dependency recovery instructions with no-store caching", async () => {
    mocks.load.mockResolvedValue({
      command: "cd -- '/managed/worktree' && npm install",
    });

    const response = await POST(
      new Request(
        "http://localhost:3000/api/tasks/task-1/dependency-recovery-instructions",
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      command: "cd -- '/managed/worktree' && npm install",
    });
    expect(mocks.load).toHaveBeenCalledWith("task-1");
  });

  it("maps a missing task to 404", async () => {
    mocks.load.mockRejectedValue(new DependencyRecoveryTaskNotFoundError());

    const response = await POST(
      new Request(
        "http://localhost:3000/api/tasks/missing/dependency-recovery-instructions",
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Task not found" });
  });

  it("maps unavailable instructions to 409", async () => {
    mocks.load.mockRejectedValue(new DependencyRecoveryUnavailableError());

    const response = await POST(
      new Request(
        "http://localhost:3000/api/tasks/task-1/dependency-recovery-instructions",
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Dependency recovery instructions are unavailable for this task",
    });
  });

  it("keeps the human-mutation gate in the HTTP adapter", async () => {
    mocks.requireHumanMutation.mockReturnValue(
      Response.json({ error: "Forbidden" }, { status: 403 }),
    );

    const response = await POST(
      new Request(
        "http://localhost:3000/api/tasks/task-1/dependency-recovery-instructions",
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
