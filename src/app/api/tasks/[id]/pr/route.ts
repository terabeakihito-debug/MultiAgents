import {
  taskPrService,
  TaskPrConflictError,
  TaskPrNotFoundError,
} from "@/core/task-pr-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    return Response.json(await taskPrService.load((await context.params).id));
  } catch (error) {
    if (error instanceof TaskPrNotFoundError) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    if (error instanceof TaskPrConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
