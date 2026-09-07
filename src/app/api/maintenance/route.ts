import { enterMaintenanceMode, leaveMaintenanceMode, lifecycleState, OperationUnavailableError } from "@/server/operation-registry";
import { rejectNonLocalRequest, requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  return Response.json({ state: lifecycleState() });
}

export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "maintenance-mode", { label: "Maintenance mode" }); if (rejection) return rejection;
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { enabled?: unknown }).enabled !== "boolean") return Response.json({ error: "Maintenance mode input is invalid" }, { status: 400 });
  try {
    if ((body as { enabled: boolean }).enabled) enterMaintenanceMode(); else leaveMaintenanceMode();
    return Response.json({ state: lifecycleState() });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Maintenance mode update failed" }, { status: error instanceof OperationUnavailableError ? 409 : 500 }); }
}
