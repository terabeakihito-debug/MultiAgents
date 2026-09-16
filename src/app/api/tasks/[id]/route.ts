import { taskCleanupService, TaskCleanupRequestError } from "@/core/task-cleanup-service";
import { taskDetailService, TaskDetailNotFoundError } from "@/core/task-detail-service";
import { initializeTaskRecovery } from "@/server/tasks";
import { rejectNonLocalRequest, requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try {
    const detail = await taskDetailService.load((await context.params).id);
    const body = detail.error
      ? { diff: detail.diff, task: detail.task, error: detail.error }
      : { diff: detail.diff, task: detail.task };
    return Response.json(body, detail.conflict ? { status: 409 } : undefined);
  } catch (error) {
    if (error instanceof TaskDetailNotFoundError) return Response.json({ error: "Task not found" }, { status: 404 });
    throw error;
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-delete", { method: "DELETE", label: "Task cleanup" }); if (rejection) return rejection;
  await initializeTaskRecovery();

  let cleanupRequest;
  try {
    const body = await request.text();
    const parsed: unknown = body ? JSON.parse(body) : {};
    cleanupRequest = taskCleanupService.parseRequest(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TaskCleanupRequestError) {
      return Response.json({ error: "Invalid cleanup request" }, { status: 400 });
    }
    throw error;
  }

  try {
    await taskCleanupService.remove((await context.params).id, cleanupRequest);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Cleanup failed" }, { status: 409 });
  }
}
