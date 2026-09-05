import { convertFinding } from "@/server/findings";
import { rejectNonHumanFindingMutation } from "@/server/request-security";
import { initializeTaskRecovery, publicTask } from "@/server/tasks";
import { getRemediationFinding } from "@/server/remediation-queue";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanFindingMutation(request, "finding-convert"); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const value = body as { confirmed?: unknown; templateId?: unknown; objective?: unknown };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["confirmed", "templateId", "objective"].includes(key)) || value.confirmed !== true || typeof value.templateId !== "string" || typeof value.objective !== "string") return Response.json({ error: "Explicit conversion confirmation, template, and objective are required" }, { status: 400 });
  try {
    const result = await convertFinding((await context.params).id, { templateId: value.templateId, objective: value.objective });
    return Response.json({ finding: result.finding, task: publicTask(result.task), remediation: getRemediationFinding(result.finding.findingId), history: getStateStore().loadFindingEvents(result.finding.findingId) }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Finding conversion failed" }, { status: 409 }); }
}
