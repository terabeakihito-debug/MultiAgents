import { getTask, initializeTaskRecovery, publicTask } from "@/server/tasks";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  await initializeTaskRecovery();
  const task = getTask((await context.params).id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  if (!task.prNumber) return Response.json({ error: "Task does not have an existing pull request" }, { status: 409 });
  return Response.json({ task: publicTask(task), pullRequest: task.prReview, intake: task.reviewIntake });
}
