import { describe, expect, it, vi } from "vitest";
import {
  createTaskCreateMutationService,
  TaskRequestError,
} from "./task-create-mutation-service";

describe("task create mutation service", () => {
  it("parses and creates a task", async () => {
    const initialize = vi.fn(async () => undefined);
    const parse = vi.fn(() => ({
      repoId: "repo-1",
      templateId: "bug_fix",
      prompt: "Fix it",
    }));
    const create = vi.fn(async () => ({ id: "task-1", repoId: "repo-1" })) as never;
    const service = createTaskCreateMutationService({
      initialize,
      parse,
      create,
    });

    await expect(
      service.createFromBody({
        repoId: "repo-1",
        templateId: "bug_fix",
        prompt: "Fix it",
      }),
    ).resolves.toEqual({ task: { id: "task-1", repoId: "repo-1" } });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      repoId: "repo-1",
      templateId: "bug_fix",
      prompt: "Fix it",
    });
  });

  it("surfaces TaskRequestError from parsing", async () => {
    const service = createTaskCreateMutationService({
      initialize: vi.fn(async () => undefined),
      parse: vi.fn(() => {
        throw new TaskRequestError("repository_required", "Repository is required");
      }),
      create: vi.fn(),
    });

    await expect(service.createFromBody({})).rejects.toBeInstanceOf(
      TaskRequestError,
    );
  });
});
