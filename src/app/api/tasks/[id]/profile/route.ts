import {
  taskProfileService,
  TaskProfileInvalidError,
  TaskProfileNotFoundError,
} from "@/core/task-profile-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;

  try {
    return Response.json(await taskProfileService.load((await context.params).id));
  } catch (error) {
    if (error instanceof TaskProfileNotFoundError) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    if (error instanceof TaskProfileInvalidError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
