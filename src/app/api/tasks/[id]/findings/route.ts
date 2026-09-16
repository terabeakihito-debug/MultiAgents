import { taskFindingsService, TaskFindingsLoadError } from "@/core/task-findings-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try {
    return Response.json(await taskFindingsService.load((await context.params).id));
  } catch (error) {
    if (error instanceof TaskFindingsLoadError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
