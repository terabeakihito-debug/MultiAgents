import { evaluateCleanupCandidates } from "@/server/cleanup";
import { rejectNonLocalRequest } from "@/server/request-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  return Response.json(await evaluateCleanupCandidates(), { headers: { "Cache-Control": "no-store" } });
}
