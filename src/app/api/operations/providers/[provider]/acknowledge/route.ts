import { acknowledgeProviderVersion, providerDiagnostics } from "@/server/provider-diagnostics";
import { requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const rejection = requireHumanMutation(request, "operations-provider-acknowledge", { label: "Provider compatibility acknowledgement" }); if (rejection) return rejection;
  const { provider } = await context.params;
  if (!(["codex", "cursor", "claude"] as const).includes(provider as "codex" | "cursor" | "claude")) return Response.json({ error: "Unknown provider" }, { status: 404 });
  const diagnostic = (await providerDiagnostics()).find((item) => item.provider === provider);
  if (!diagnostic?.version || !["supported", "supported_with_warning"].includes(diagnostic.status)) return Response.json({ error: "Only a passing provider version can be acknowledged" }, { status: 409 });
  acknowledgeProviderVersion(provider as "codex" | "cursor" | "claude", diagnostic.version);
  return Response.json({ provider, version: diagnostic.version }, { headers: { "Cache-Control": "no-store" } });
}
