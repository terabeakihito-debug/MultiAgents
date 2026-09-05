import { extractTaskFindings } from "@/server/findings";
import { rejectNonHumanFindingMutation } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanFindingMutation(request, "finding-extract"); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || (body as { confirmed?: unknown }).confirmed !== true) return Response.json({ error: "Explicit extraction confirmation is required" }, { status: 400 });
  try { return Response.json({ findings: await extractTaskFindings((await context.params).id) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Finding extraction failed" }, { status: 409 }); }
}
