import { taskService, TaskRequestError } from "@/core/task-service";
import { rejectNonLocalRequest, requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  return Response.json({ tasks: await taskService.list() });
}

export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "task-create", { label: "Task creation" });
  if (rejection) return rejection;

  // Preserve the pre-existing recovery timing: task recovery is initialized
  // before request-body validation, while the operation itself now lives in core.
  await taskService.initialize();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  let taskRequest;
  try {
    taskRequest = taskService.parseCreateRequest(body);
  } catch (error) {
    if (error instanceof TaskRequestError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }

  try {
    return Response.json({ task: await taskService.create(taskRequest) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Task creation failed" }, { status: 400 });
  }
}
