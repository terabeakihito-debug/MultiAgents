import { dismissFinding } from "@/server/findings";
import { rejectNonHumanFindingMutation } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";
import { getRemediationFinding } from "@/server/remediation-queue";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanFindingMutation(request, "finding-dismiss"); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const value = body as { confirmed?: unknown; reason?: unknown };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["confirmed", "reason"].includes(key)) || value.confirmed !== true || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 1_000))) return Response.json({ error: "Explicit dismissal confirmation and an optional short reason are required" }, { status: 400 });
  try { const finding = dismissFinding((await context.params).id, value.reason as string | undefined); return Response.json({ finding, remediation: getRemediationFinding(finding.findingId), history: getStateStore().loadFindingEvents(finding.findingId) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Finding dismissal failed" }, { status: 409 }); }
}
