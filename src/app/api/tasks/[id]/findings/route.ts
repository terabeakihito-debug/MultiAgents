import { listTaskFindings } from "@/server/findings";
import { rejectNonLocalRequest } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";
import { getRemediationFinding } from "@/server/remediation-queue";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  await initializeTaskRecovery();
  try {
    const findings = listTaskFindings((await context.params).id);
    return Response.json({ findings: findings.map((finding) => ({ ...finding, remediation: getRemediationFinding(finding.findingId), history: getStateStore().loadFindingEvents(finding.findingId) })) });
  }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not load findings" }, { status: 404 }); }
}
