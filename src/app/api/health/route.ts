import { healthReadiness, ReadinessError } from "@/server/operational-health";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try { return Response.json(await healthReadiness()); }
  catch (error) {
    return Response.json({ status: "unavailable", database: "unavailable", errorCode: error instanceof ReadinessError ? error.message : "readiness_failed" }, { status: 503 });
  }
}
