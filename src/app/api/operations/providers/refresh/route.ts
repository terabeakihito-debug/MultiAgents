import { providerDiagnostics } from "@/server/provider-diagnostics";
import { requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "operations-provider-refresh", { label: "Provider diagnostics refresh" }); if (rejection) return rejection;
  return Response.json({ providers: await providerDiagnostics({ force: true }) }, { headers: { "Cache-Control": "no-store" } });
}
