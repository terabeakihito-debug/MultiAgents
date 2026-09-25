import { agents } from "../agents";
import {
  createReviewRerunStream,
  parseReviewRerunCommand,
  reconstructReviewRerunRequest,
} from "../flows/review-rerun";
import { createDiffSnapshot } from "../server/pull-request";
import { defaultFlowStepModels } from "../flows/agent-models";
import { defaultFlowStepAgents } from "../flows/step-agents";
import { prepareTaskRuntime, taskRuntimeExecutor, taskRuntimeExecutorForStepModels } from "../server/task-runtime";
import {
  beginTaskRerun,
  completeTaskReview,
  executionPromptForTask,
  executionRootForTask,
  getTask,
  getTaskDiff,
  initializeTaskRecovery,
  recordFlowEvent,
  requireTaskTemplate,
} from "../server/tasks";

export type ReviewRerunErrorBody = { error: string };

export type ReviewRerunPrepareResult =
  | { kind: "error"; status: number; body: ReviewRerunErrorBody }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

type ReviewRerunMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  parseCommand: typeof parseReviewRerunCommand;
  reconstruct: typeof reconstructReviewRerunRequest;
  loadTask: typeof getTask;
  prepareRuntime: typeof prepareTaskRuntime;
  beginRerun: typeof beginTaskRerun;
  requireTemplate: typeof requireTaskTemplate;
  executionPrompt: typeof executionPromptForTask;
  executionRoot: typeof executionRootForTask;
  createStream: typeof createReviewRerunStream;
  diffFingerprint: typeof createDiffSnapshot;
  loadDiff: typeof getTaskDiff;
  runtimeExecutor: typeof taskRuntimeExecutor;
  recordEvent: typeof recordFlowEvent;
  completeReview: typeof completeTaskReview;
  agentSet: typeof agents;
};

export function createReviewRerunMutationService(
  dependencies: ReviewRerunMutationDependencies = {
    initialize: initializeTaskRecovery,
    parseCommand: parseReviewRerunCommand,
    reconstruct: reconstructReviewRerunRequest,
    loadTask: getTask,
    prepareRuntime: prepareTaskRuntime,
    beginRerun: beginTaskRerun,
    requireTemplate: requireTaskTemplate,
    executionPrompt: executionPromptForTask,
    executionRoot: executionRootForTask,
    createStream: createReviewRerunStream,
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
    ): Promise<ReviewRerunPrepareResult> {
      await dependencies.initialize();
      const command = dependencies.parseCommand(body);
      if ("error" in command) {
        return { kind: "error", status: 400, body: command };
      }

      const task = dependencies.loadTask(command.taskId);
      if (!task) {
        return {
          kind: "error",
          status: 400,
          body: { error: "Valid persisted taskId is required" },
        };
      }

      const persisted = dependencies.reconstruct(task, command.stepId);
      if ("error" in persisted) {
        return { kind: "error", status: 409, body: persisted };
      }

      let taskRuntime: Awaited<ReturnType<typeof prepareTaskRuntime>>;
      try {
        taskRuntime = await dependencies.prepareRuntime(task);
        dependencies.beginRerun(task, task.prompt);
      } catch (error) {
        return {
          kind: "error",
          status: 409,
          body: {
            error:
              error instanceof Error
                ? error.message
                : "Task cannot rerun review",
          },
        };
      }

      const template = dependencies.requireTemplate(task);
      const executionRequest = {
        ...persisted,
        prompt: dependencies.executionPrompt(task, task.prompt),
      };

      return {
        kind: "stream",
        stream: dependencies.createStream(
          executionRequest,
          requestSignal,
          undefined,
          {
            cwd: dependencies.executionRoot(task),
            roles: template.roles,
            repositoryReadOnly: template.readOnly,
            fingerprint: async () =>
              (await dependencies.diffFingerprint(task)).hash,
            getDiff: async () => {
              const diff = await dependencies.loadDiff(task);
              return [diff.patch, diff.untrackedPatch].filter(Boolean).join("\n\n");
            },
            runtimePolicies: taskRuntime.policies,
            executeAgent: taskRuntimeExecutorForStepModels(
              taskRuntime,
              dependencies.agentSet,
              task.flowStepModels ?? defaultFlowStepModels(task.flowStepAgents ?? defaultFlowStepAgents()),
            ),
            onEvent: (event) => dependencies.recordEvent(task, event),
            onComplete: (result) =>
              dependencies.completeReview(
                task,
                result.status === "completed" &&
                  result.stepId === "codex_final" &&
                  result.steps[3]?.status === "completed",
              ),
          },
        ),
      };
    },
  };
}

/** Framework-independent review rerun mutation used by transport adapters. */
export const reviewRerunMutationService = createReviewRerunMutationService();
