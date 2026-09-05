import { dismissFinding } from "@/server/findings";
import { rejectNonHumanFindingMutation } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanFindingMutation(request, "finding-dismiss"); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const value = body as { confirmed?: unknown; reason?: unknown };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["confirmed", "reason"].includes(key)) || value.confirmed !== true || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 1_000))) return Response.json({ error: "Explicit dismissal confirmation and an optional short reason are required" }, { status: 400 });
  try { return Response.json({ finding: dismissFinding((await context.params).id, value.reason as string | undefined) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Finding dismissal failed" }, { status: 409 }); }
}
