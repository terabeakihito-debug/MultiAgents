import { deleteTask, getTask, getTaskDiff } from "@/server/tasks";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  const task = getTask((await context.params).id); if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  return Response.json({ diff: await getTaskDiff(task) });
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try { await deleteTask((await context.params).id); return new Response(null, { status: 204 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Cleanup failed" }, { status: 409 }); }
}
