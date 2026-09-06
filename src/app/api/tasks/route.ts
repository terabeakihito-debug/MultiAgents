import { createTask, initializeTaskRecovery, listTasks, publicTask } from "@/server/tasks";
import { rejectNonLocalRequest, requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  await initializeTaskRecovery();
  return Response.json({ tasks: listTasks().map(publicTask) });
}
export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "task-create", { label: "Task creation" }); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const repoId = (body as { repoId?: unknown })?.repoId;
  const templateId = (body as { templateId?: unknown })?.templateId;
  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof repoId !== "string") return Response.json({ error: "Repository is required" }, { status: 400 });
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["repoId", "templateId", "prompt"].includes(key))) return Response.json({ error: "Task creation contains a forbidden field" }, { status: 400 });
  if (templateId !== undefined && typeof templateId !== "string") return Response.json({ error: "Task template is invalid" }, { status: 400 });
  if (prompt !== undefined && (typeof prompt !== "string" || !prompt.trim() || prompt.length > 20_000)) return Response.json({ error: "Task prompt must be 1 to 20000 characters" }, { status: 400 });
  try { const task = await createTask(repoId, { templateId, prompt }); return Response.json({ task: publicTask(task) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Task creation failed" }, { status: 400 }); }
}
