import { agents } from "../agents";
import { createReviewFlowStream } from "../flows/review-stream";
import { createDiffSnapshot } from "../server/pull-request";
import { prepareTaskRuntime, taskRuntimeExecutor } from "../server/task-runtime";
import {
  beginTaskReview,
  completeTaskReview,
  executionPromptForTask,
  executionRootForTask,
  getTask,
  getTaskDiff,
  initializeTaskRecovery,
  recordFlowEvent,
  requireTaskTemplate,
} from "../server/tasks";
import { MAX_REVIEW_PROMPT_LENGTH } from "./review-service";

export type ReviewFlowStreamErrorBody = { error: string };

export type ReviewFlowStreamPrepareResult =
  | { kind: "error"; status: number; body: ReviewFlowStreamErrorBody }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

type ReviewFlowStreamMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  loadTask: typeof getTask;
  prepareRuntime: typeof prepareTaskRuntime;
  beginReview: typeof beginTaskReview;
  requireTemplate: typeof requireTaskTemplate;
  executionPrompt: typeof executionPromptForTask;
  executionRoot: typeof executionRootForTask;
  createStream: typeof createReviewFlowStream;
  diffFingerprint: typeof createDiffSnapshot;
  loadDiff: typeof getTaskDiff;
  runtimeExecutor: typeof taskRuntimeExecutor;
  recordEvent: typeof recordFlowEvent;
  completeReview: typeof completeTaskReview;
  agentSet: typeof agents;
};

export function createReviewFlowStreamMutationService(
  dependencies: ReviewFlowStreamMutationDependencies = {
    initialize: initializeTaskRecovery,
    loadTask: getTask,
    prepareRuntime: prepareTaskRuntime,
    beginReview: beginTaskReview,
    requireTemplate: requireTaskTemplate,
    executionPrompt: executionPromptForTask,
    executionRoot: executionRootForTask,
    createStream: createReviewFlowStream,
    diffFingerprint: createDiffSnapshot,
    loadDiff: getTaskDiff,
    runtimeExecutor: taskRuntimeExecutor,
    recordEvent: recordFlowEvent,
    completeReview: completeTaskReview,
    agentSet: agents,
  },
) {
  return {
    async prepare(
      body: unknown,
      requestSignal: AbortSignal,
    ): Promise<ReviewFlowStreamPrepareResult> {
      await dependencies.initialize();

      const prompt = (body as { prompt?: unknown })?.prompt;
      const taskId = (body as { taskId?: unknown })?.taskId;
      if (typeof prompt !== "string" || !prompt.trim()) {
        return {
          kind: "error",
          status: 400,
          body: { error: "Prompt is required" },
        };
      }
      if (prompt.length > MAX_REVIEW_PROMPT_LENGTH) {
        return {
          kind: "error",
          status: 400,
          body: {
            error: `Prompt must be ${MAX_REVIEW_PROMPT_LENGTH} characters or fewer`,
          },
        };
      }

      const task =
        typeof taskId === "string" ? dependencies.loadTask(taskId) : undefined;
      if (taskId !== undefined && !task) {
        return {
          kind: "error",
          status: 400,
          body: { error: "Valid repository taskId is required" },
        };
      }

      let taskRuntime: Awaited<ReturnType<typeof prepareTaskRuntime>> | undefined;
      try {
        if (task) {
          taskRuntime = await dependencies.prepareRuntime(task);
          dependencies.beginReview(task, prompt);
        }
      } catch (error) {
        return {
          kind: "error",
          status: 409,
          body: {
            error:
              error instanceof Error
                ? error.message
                : "Task cannot start review",
          },
        };
      }

      const executionPrompt = task
        ? dependencies.executionPrompt(task, prompt)
        : prompt;
      const template = task ? dependencies.requireTemplate(task) : undefined;

      return {
        kind: "stream",
        stream: dependencies.createStream(
          executionPrompt,
          requestSignal,
          undefined,
          task
            ? {
                cwd: dependencies.executionRoot(task),
                roles: template!.roles,
                repositoryReadOnly: template!.readOnly,
                runtimePolicies: taskRuntime!.policies,
                executeAgent: dependencies.runtimeExecutor(
                  taskRuntime!,
                  dependencies.agentSet,
                ),
                fingerprint: async () =>
                  (await dependencies.diffFingerprint(task)).hash,
                getDiff: async () => {
                  const diff = await dependencies.loadDiff(task);
                  return [diff.patch, diff.untrackedPatch]
                    .filter(Boolean)
                    .join("\n\n");
                },
                onEvent: (event) => dependencies.recordEvent(task, event),
                onComplete: (result) =>
                  dependencies.completeReview(
                    task,
                    result.status === "completed" &&
                      result.steps[3]?.status === "completed",
                  ),
              }
            : {},
        ),
      };
    },
  };
}

/** Framework-independent review flow stream mutation used by transport adapters. */
export const reviewFlowStreamMutationService =
  createReviewFlowStreamMutationService();
