import { getTask, getTaskDiff, publicTask, resumeTask } from "@/server/tasks";
import { prepareApproval } from "@/server/pull-request";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  const id = (await context.params).id;
  try {
    const task = await resumeTask(id);
    if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
    if (!task.worktreeAvailable) return Response.json({ task: publicTask(task) });
    const prepared = await prepareApproval(task);
    return Response.json({ ...prepared, task: publicTask(task) });
  } catch (error) {
    const task = getTask(id);
    if (!task?.worktreeAvailable) return Response.json({ task: task ? publicTask(task) : undefined, error: error instanceof Error ? error.message : "Task resume failed" }, { status: 409 });
    return Response.json({ task: publicTask(task), diff: await getTaskDiff(task), error: error instanceof Error ? error.message : "Task resume failed" }, { status: 409 });
  }
}
