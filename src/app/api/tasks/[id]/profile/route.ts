import { rejectNonLocalRequest } from "@/server/request-security";
import { getTask, initializeTaskRecovery, requireTaskProfile } from "@/server/tasks";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  await initializeTaskRecovery();
  const task = getTask((await context.params).id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  try { return Response.json({ profile: requireTaskProfile(task) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Task profile snapshot is invalid" }, { status: 409 }); }
}
