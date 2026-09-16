import { runtimeSandboxStatusService } from "@/core/runtime-sandbox-status-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  const result = await runtimeSandboxStatusService.load();
  return Response.json(result.body, { status: result.statusCode });
}
