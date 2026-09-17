import { describe, expect, it, vi } from "vitest";
import {
  createTaskRecoverPrMutationService,
  TaskRecoverPrInputError,
} from "./task-recover-pr-mutation-service";

describe("task recover-pr mutation service", () => {
  it("requires repoId and prNumber", async () => {
    const service = createTaskRecoverPrMutationService({
      initialize: vi.fn(async () => undefined),
      list: vi.fn(() => []),
      recover: vi.fn(),
      toPublicTask: vi.fn(),
    });

    await expect(service.apply({ repoId: "repo-1" })).rejects.toBeInstanceOf(
      TaskRecoverPrInputError,
    );
  });

  it("returns an existing task when one matches", async () => {
    const existing = { repoId: "repo-1", prNumber: 7, id: "task-1" } as never;
    const service = createTaskRecoverPrMutationService({
      initialize: vi.fn(async () => undefined),
      list: vi.fn(() => [existing]),
      recover: vi.fn(),
      toPublicTask: vi.fn(() => ({ id: "task-1", public: true })) as never,
    });

    await expect(
      service.apply({ repoId: "repo-1", prNumber: 7 }),
    ).resolves.toEqual({ task: { id: "task-1", public: true } });
  });
});
