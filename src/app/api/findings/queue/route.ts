import { rejectNonLocalRequest } from "@/server/request-security";
import { getRemediationQueue, parseRemediationQueueQuery, RemediationQueueQueryError } from "@/server/remediation-queue";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try { return Response.json(getRemediationQueue(parseRemediationQueueQuery(new URL(request.url)))); }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Remediation queue request failed" }, { status: error instanceof RemediationQueueQueryError ? 400 : 500 });
  }
}
