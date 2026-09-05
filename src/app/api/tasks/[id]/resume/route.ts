import { getTaskDiff, publicTask, resumeTask } from "@/server/tasks";
import { prepareApproval } from "@/server/pull-request";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  const task = await resumeTask((await context.params).id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  if (!task.worktreeAvailable) return Response.json({ task: publicTask(task) });
  try {
    const prepared = await prepareApproval(task);
    return Response.json({ ...prepared, task: publicTask(task) });
  } catch (error) {
    return Response.json({ task: publicTask(task), diff: await getTaskDiff(task), error: error instanceof Error ? error.message : "Task resume failed" }, { status: 409 });
  }
}
