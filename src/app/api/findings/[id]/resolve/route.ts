import { markFindingResolved } from "@/server/findings";
import { rejectNonHumanFindingMutation } from "@/server/request-security";
import { getRemediationFinding } from "@/server/remediation-queue";
import { initializeTaskRecovery } from "@/server/tasks";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanFindingMutation(request, "finding-resolve"); if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || (body as { confirmed?: unknown }).confirmed !== true) {
    return Response.json({ error: "Explicit resolution confirmation is required" }, { status: 400 });
  }
  try {
    const id = (await context.params).id;
    return Response.json({ finding: markFindingResolved(id), remediation: getRemediationFinding(id), history: getStateStore().loadFindingEvents(id) });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Finding resolution failed" }, { status: 409 }); }
}
