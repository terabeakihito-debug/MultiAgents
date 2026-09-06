import { createReviewRerunStream, parseReviewRerunRequest } from "@/flows/review-rerun";
import { rejectNonLocalRequest } from "@/server/request-security";
import { beginTaskRerun, completeTaskReview, executionPromptForTask, executionRootForTask, getTask, initializeTaskRecovery, recordFlowEvent, requireTaskTemplate } from "@/server/tasks";
import { createDiffSnapshot } from "@/server/pull-request";
import { agents } from "@/agents";
import { prepareTaskRuntime, taskRuntimeExecutor } from "@/server/task-runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const parsed = parseReviewRerunRequest(body);
  if ("error" in parsed) return Response.json(parsed, { status: 400 });
  const taskId = (body as { taskId?: unknown }).taskId;
  const task = typeof taskId === "string" ? getTask(taskId) : undefined;
  if (taskId !== undefined && !task) return Response.json({ error: "Valid repository taskId is required" }, { status: 400 });
  let taskRuntime: Awaited<ReturnType<typeof prepareTaskRuntime>> | undefined;
  try { if (task) { taskRuntime = await prepareTaskRuntime(task); beginTaskRerun(task, parsed.prompt); } }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Task cannot rerun review" }, { status: 409 }); }
  const template = task ? requireTaskTemplate(task) : undefined;
  const executionRequest = task ? { ...parsed, prompt: executionPromptForTask(task, parsed.prompt) } : parsed;
  return new Response(createReviewRerunStream(executionRequest, request.signal, undefined, task ? {
    cwd: executionRootForTask(task),
    roles: template!.roles,
    fingerprint: async () => (await createDiffSnapshot(task)).hash,
    runtimePolicies: taskRuntime!.policies,
    executeAgent: taskRuntimeExecutor(taskRuntime!, agents),
    onEvent: (event) => recordFlowEvent(task, event),
    onComplete: (result) => completeTaskReview(task, result.status === "completed" && result.stepId === "codex_final" && result.steps[3]?.status === "completed"),
  } : {}), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
