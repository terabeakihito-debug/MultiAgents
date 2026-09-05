import { acceptFinding } from "@/server/findings";
import { rejectNonHumanFindingMutation } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanFindingMutation(request, "finding-accept"); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || (body as { confirmed?: unknown }).confirmed !== true) return Response.json({ error: "Explicit acceptance confirmation is required" }, { status: 400 });
  try { return Response.json({ finding: acceptFinding((await context.params).id) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Finding acceptance failed" }, { status: 409 }); }
}
