import { describe, expect, it, vi } from "vitest";
import { publicTask as projectTask, type RepoTask } from "../server/tasks";
import { createTaskService, MAX_TASK_PROMPT_LENGTH, parseTaskCreateRequest, TaskRequestError } from "./task-service";

const task = { id: "task-1" } as unknown as RepoTask;
const projectedTask = {} as ReturnType<typeof projectTask>;

describe("task service", () => {
  it("validates task creation without depending on HTTP", () => {
    expect(parseTaskCreateRequest({ repoId: "repo", templateId: "template", prompt: "do work" })).toEqual({
      repoId: "repo",
      templateId: "template",
      prompt: "do work",
    });
    expect(() => parseTaskCreateRequest({})).toThrowError(TaskRequestError);
    expect(() => parseTaskCreateRequest({ forbidden: true })).toThrow("Repository is required");
    expect(() => parseTaskCreateRequest({ repoId: "repo", forbidden: true })).toThrow("Task creation contains a forbidden field");
    expect(() => parseTaskCreateRequest({ repoId: "repo", prompt: "x".repeat(MAX_TASK_PROMPT_LENGTH + 1) })).toThrow(
      "Task prompt must be 1 to 20000 characters",
    );
  });

  it("initializes recovery before listing and projects public tasks", async () => {
    const initializeRecovery = vi.fn(async () => undefined);
    const list = vi.fn(() => [task]);
    const toPublic = vi.fn((value: RepoTask) => { void value; return projectedTask; });
    const create = vi.fn(async () => task);
    const service = createTaskService({ initializeRecovery, list, create, toPublic } as unknown as Parameters<typeof createTaskService>[0]);

    await expect(service.list()).resolves.toEqual([projectedTask]);
    expect(initializeRecovery).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(toPublic).toHaveBeenCalledTimes(1);
    expect(toPublic.mock.calls[0][0]).toBe(task);
  });

  it("initializes recovery before creation and preserves task options", async () => {
    const initializeRecovery = vi.fn(async () => undefined);
    const list = vi.fn(() => [] as RepoTask[]);
    const create = vi.fn(async () => task);
    const toPublic = vi.fn((value: RepoTask) => { void value; return projectedTask; });
    const service = createTaskService({ initializeRecovery, list, create, toPublic } as unknown as Parameters<typeof createTaskService>[0]);

    await expect(service.create({ repoId: "repo", templateId: "template", prompt: "do work" })).resolves.toEqual(projectedTask);
    expect(initializeRecovery).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("repo", { templateId: "template", prompt: "do work" });
    expect(toPublic).toHaveBeenCalledWith(task);
  });
});
