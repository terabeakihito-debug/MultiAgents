import {
  taskRuntimePolicyService,
  TaskRuntimePolicyNotFoundError,
  TaskRuntimePolicyUnavailableError,
} from "@/core/task-runtime-policy-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    return Response.json(await taskRuntimePolicyService.load((await context.params).id));
  } catch (error) {
    if (error instanceof TaskRuntimePolicyNotFoundError) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    if (error instanceof TaskRuntimePolicyUnavailableError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
