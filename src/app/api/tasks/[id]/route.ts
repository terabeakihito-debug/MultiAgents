import { deleteTask, getTask, getTaskDiff, publicTask } from "@/server/tasks";
import { prepareApproval } from "@/server/pull-request";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  const task = getTask((await context.params).id); if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  if (!task.worktreeAvailable) return Response.json({
    diff: { trackedFiles: [], untrackedFiles: [], stat: "", patch: "", untrackedPatch: "", truncated: false, approvable: false, blockedReason: "Managed task worktree is unavailable in this review-only session." },
    task: publicTask(task),
  });
  try { return Response.json(await prepareApproval(task)); }
  catch (error) {
    return Response.json({ diff: await getTaskDiff(task), task: publicTask(task), error: error instanceof Error ? error.message : "Could not prepare approval" }, { status: 409 });
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try { await deleteTask((await context.params).id); return new Response(null, { status: 204 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Cleanup failed" }, { status: 409 }); }
}
