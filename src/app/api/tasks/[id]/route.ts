import { taskDetailService, TaskDetailNotFoundError } from "@/core/task-detail-service";
import { deleteTask, initializeTaskRecovery } from "@/server/tasks";
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
  let input: { confirmedPrCleanup?: boolean } = {};
  try {
    const body = await request.text();
    if (body) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (Object.keys(parsed).some((key) => key !== "confirmedPrCleanup") || (parsed.confirmedPrCleanup !== undefined && typeof parsed.confirmedPrCleanup !== "boolean")) {
        return Response.json({ error: "Invalid cleanup request" }, { status: 400 });
      }
      input = { confirmedPrCleanup: parsed.confirmedPrCleanup === true };
    }
  } catch { return Response.json({ error: "Invalid cleanup request" }, { status: 400 }); }
  try { await deleteTask((await context.params).id, input); return new Response(null, { status: 204 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Cleanup failed" }, { status: 409 }); }
}
