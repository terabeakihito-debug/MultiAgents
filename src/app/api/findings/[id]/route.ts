import { findingHistory } from "@/server/findings";
import { rejectNonLocalRequest } from "@/server/request-security";
import { getRemediationFinding } from "@/server/remediation-queue";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try {
    const id = (await context.params).id;
    const finding = getStateStore().loadFinding(id);
    if (!finding) throw new Error("Finding not found");
    return Response.json({ finding, remediation: getRemediationFinding(id), history: findingHistory(id) });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not load finding" }, { status: 404 }); }
}
