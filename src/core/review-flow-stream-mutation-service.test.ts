import { describe, expect, it, vi } from "vitest";
import { createReviewFlowStreamMutationService } from "./review-flow-stream-mutation-service";
import type { RepoTask } from "../server/tasks";

describe("review flow stream mutation service", () => {
  it("requires a prompt before opening a stream", async () => {
    const service = createReviewFlowStreamMutationService({
      initialize: vi.fn(async () => undefined),
      loadTask: vi.fn(),
      prepareRuntime: vi.fn(),
      beginReview: vi.fn(),
      requireTemplate: vi.fn(),
      executionPrompt: vi.fn(),
      executionRoot: vi.fn(),
      createStream: vi.fn(),
      diffFingerprint: vi.fn(),
      loadDiff: vi.fn(),
      runtimeExecutor: vi.fn(),
      recordEvent: vi.fn(),
      completeReview: vi.fn(),
      agentSet: {} as never,
    });

    await expect(
      service.prepare({}, new AbortController().signal),
    ).resolves.toEqual({
      kind: "error",
      status: 400,
      body: { error: "Prompt is required" },
    });
  });

  it("selects the autonomous stream for an autonomous task", async () => {
    const task = { id: "11111111-1111-1111-1111-111111111111", autonomous: true } as unknown as RepoTask;
    const createAutonomousStream = vi.fn(() => new ReadableStream<Uint8Array>());
    const createStream = vi.fn();
    const service = createReviewFlowStreamMutationService({
      initialize: vi.fn(async () => undefined),
      loadTask: vi.fn(() => task),
      prepareRuntime: vi.fn(async () => ({ policies: {} })),
      beginReview: vi.fn(),
      requireTemplate: vi.fn(() => ({ readOnly: false, roles: {} })),
      executionPrompt: vi.fn((_task: RepoTask, prompt: string) => prompt),
      executionRoot: vi.fn(() => "."),
      createStream,
      createAutonomousStream,
      diffFingerprint: vi.fn(),
      loadDiff: vi.fn(),
      runtimeExecutor: vi.fn(),
      recordEvent: vi.fn(),
      completeReview: vi.fn(),
      agentSet: {} as never,
    } as never);

    await expect(service.prepare({ taskId: task.id, prompt: "Fix it" }, new AbortController().signal)).resolves.toMatchObject({ kind: "stream" });
    expect(createAutonomousStream).toHaveBeenCalledOnce();
    expect(createStream).not.toHaveBeenCalled();
  });
});
