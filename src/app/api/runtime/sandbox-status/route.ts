import { checkOsSandboxAvailability, publicOsSandboxPolicy } from "@/server/os-sandbox";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    const backend = await checkOsSandboxAvailability();
    return Response.json({
      status: "enforced",
      backend: backend.backend,
      policyVersion: backend.version,
      agentReadOnly: publicOsSandboxPolicy("agent_read_only"),
      agentImplement: publicOsSandboxPolicy("agent_implement"),
      validation: publicOsSandboxPolicy("validation"),
    });
  } catch (error) {
    return Response.json({
      status: "unavailable",
      error: "OS sandbox unavailable. Task execution blocked.",
      failureCode: error instanceof Error && "failureCode" in error ? error.failureCode : "namespace_unsupported",
    }, { status: 503 });
  }
}
