import { createReviewRerunStream, parseReviewRerunCommand, reconstructReviewRerunRequest } from "@/flows/review-rerun";
import { requireHumanMutation } from "@/server/request-security";
import { beginTaskRerun, completeTaskReview, executionPromptForTask, executionRootForTask, getTask, initializeTaskRecovery, recordFlowEvent, requireTaskTemplate } from "@/server/tasks";
import { createDiffSnapshot } from "@/server/pull-request";
import { agents } from "@/agents";
import { prepareTaskRuntime, taskRuntimeExecutor } from "@/server/task-runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "review-rerun", { label: "Review rerun" });
  if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const command = parseReviewRerunCommand(body);
  if ("error" in command) return Response.json(command, { status: 400 });
  const task = getTask(command.taskId);
  if (!task) return Response.json({ error: "Valid persisted taskId is required" }, { status: 400 });
  const persisted = reconstructReviewRerunRequest(task, command.stepId);
  if ("error" in persisted) return Response.json(persisted, { status: 409 });
  let taskRuntime: Awaited<ReturnType<typeof prepareTaskRuntime>>;
  try { taskRuntime = await prepareTaskRuntime(task); beginTaskRerun(task, task.prompt); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Task cannot rerun review" }, { status: 409 }); }
  const template = requireTaskTemplate(task);
  const executionRequest = { ...persisted, prompt: executionPromptForTask(task, task.prompt) };
  return new Response(createReviewRerunStream(executionRequest, request.signal, undefined, {
    cwd: executionRootForTask(task),
    roles: template.roles,
    fingerprint: async () => (await createDiffSnapshot(task)).hash,
    runtimePolicies: taskRuntime.policies,
    executeAgent: taskRuntimeExecutor(taskRuntime, agents),
    onEvent: (event) => recordFlowEvent(task, event),
    onComplete: (result) => completeTaskReview(task, result.status === "completed" && result.stepId === "codex_final" && result.steps[3]?.status === "completed"),
  }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
