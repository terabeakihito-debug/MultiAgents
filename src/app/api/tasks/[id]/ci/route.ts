import { taskCiService, TaskCiNotFoundError } from "@/core/task-ci-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    return Response.json(await taskCiService.load((await context.params).id));
  } catch (error) {
    if (error instanceof TaskCiNotFoundError) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    throw error;
  }
}
