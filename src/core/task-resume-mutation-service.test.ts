import { describe, expect, it, vi } from "vitest";
import { createTaskResumeMutationService } from "./task-resume-mutation-service";

describe("task resume mutation service", () => {
  it("returns not found when resume yields no task", async () => {
    const service = createTaskResumeMutationService({
      resume: vi.fn(async () => undefined),
      loadTask: vi.fn(),
      prepare: vi.fn(),
      loadDiff: vi.fn(),
      toPublicTask: vi.fn((task) => task),
    });

    await expect(service.apply("task-1")).resolves.toEqual({
      status: 404,
      body: { error: "Task not found" },
    });
  });

  it("returns public task when worktree is unavailable", async () => {
    const task = { id: "task-1", worktreeAvailable: false } as never;
    const service = createTaskResumeMutationService({
      resume: vi.fn(async () => task),
      loadTask: vi.fn(),
      prepare: vi.fn(),
      loadDiff: vi.fn(),
      toPublicTask: vi.fn(() => ({ id: "task-1", public: true })) as never,
    });

    await expect(service.apply("task-1")).resolves.toEqual({
      status: 200,
      body: { task: { id: "task-1", public: true } },
    });
  });
});
