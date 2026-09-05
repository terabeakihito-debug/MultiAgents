import { humanPriorities, type HumanPriority } from "@/findings/types";
import { changeFindingPriority } from "@/server/findings";
import { rejectNonHumanFindingMutation } from "@/server/request-security";
import { getRemediationFinding } from "@/server/remediation-queue";
import { initializeTaskRecovery } from "@/server/tasks";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanFindingMutation(request, "finding-priority"); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const value = body as { confirmed?: unknown; priority?: unknown };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["confirmed", "priority"].includes(key)) || value.confirmed !== true || !humanPriorities.includes(value.priority as HumanPriority)) {
    return Response.json({ error: "Explicit confirmation and a valid human priority are required" }, { status: 400 });
  }
  try {
    const id = (await context.params).id;
    return Response.json({ finding: changeFindingPriority(id, value.priority as HumanPriority), remediation: getRemediationFinding(id), history: getStateStore().loadFindingEvents(id) });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Finding priority update failed" }, { status: 409 }); }
}
