import { createReviewFlowStream } from "@/flows/review-stream";
import { rejectNonLocalRequest } from "@/server/request-security";
import { beginTaskReview, completeTaskReview, executionPromptForTask, executionRootForTask, getTask, getTaskDiff, initializeTaskRecovery, recordFlowEvent, requireTaskTemplate } from "@/server/tasks";
import { createDiffSnapshot } from "@/server/pull-request";

export const runtime = "nodejs";
const MAX_PROMPT_LENGTH = 20_000;

export async function POST(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  await initializeTaskRecovery();

  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const prompt = (body as { prompt?: unknown })?.prompt;
  const taskId = (body as { taskId?: unknown })?.taskId;
  if (typeof prompt !== "string" || !prompt.trim()) return Response.json({ error: "Prompt is required" }, { status: 400 });
  if (prompt.length > MAX_PROMPT_LENGTH) return Response.json({ error: `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` }, { status: 400 });

  const task = typeof taskId === "string" ? getTask(taskId) : undefined;
  if (taskId !== undefined && !task) return Response.json({ error: "Valid repository taskId is required" }, { status: 400 });
  try { if (task) beginTaskReview(task, prompt); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Task cannot start review" }, { status: 409 }); }
  const executionPrompt = task ? executionPromptForTask(task, prompt) : prompt;
  const template = task ? requireTaskTemplate(task) : undefined;
  return new Response(createReviewFlowStream(executionPrompt, request.signal, undefined, task ? {
    cwd: executionRootForTask(task),
    roles: template!.roles,
    repositoryReadOnly: template!.readOnly,
    fingerprint: async () => (await createDiffSnapshot(task)).hash,
    getDiff: async () => { const diff = await getTaskDiff(task); return [diff.patch, diff.untrackedPatch].filter(Boolean).join("\n\n"); },
    onEvent: (event) => recordFlowEvent(task, event),
    onComplete: (result) => completeTaskReview(task, result.status === "completed" && result.steps[3]?.status === "completed"),
  } : {}), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
