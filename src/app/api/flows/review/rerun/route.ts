import { createReviewRerunStream, parseReviewRerunRequest } from "@/flows/review-rerun";
import { rejectNonLocalRequest } from "@/server/request-security";
import { beginTaskRerun, completeTaskReview, getTask, initializeTaskRecovery, recordFlowEvent, requireTaskProfile } from "@/server/tasks";
import { createDiffSnapshot } from "@/server/pull-request";

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
  if (task && !task.worktreeAvailable) return Response.json({ error: task.recoveryMessage ?? "Managed task worktree is unavailable" }, { status: 409 });
  try { if (task) beginTaskRerun(task, parsed.prompt); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Task cannot rerun review" }, { status: 409 }); }
  return new Response(createReviewRerunStream(parsed, request.signal, undefined, task ? {
    cwd: task.worktreePath,
    roles: requireTaskProfile(task).roles,
    fingerprint: async () => (await createDiffSnapshot(task)).hash,
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
