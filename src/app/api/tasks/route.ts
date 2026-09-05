import { createTask, listTasks, publicTask } from "@/server/tasks";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  return Response.json({ tasks: listTasks().map(publicTask) });
}
export async function POST(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const repoId = (body as { repoId?: unknown })?.repoId;
  if (typeof repoId !== "string") return Response.json({ error: "Repository is required" }, { status: 400 });
  try { const task = await createTask(repoId); return Response.json({ task: publicTask(task) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Task creation failed" }, { status: 400 }); }
}
