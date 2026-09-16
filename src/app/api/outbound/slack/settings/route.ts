import { outboundSlackSettingsService } from "@/core/outbound-slack-settings-service";
import { OutboundInputError, parseOutboundChannelConfig } from "@/server/outbound-notifications";
import { rejectNonHumanOutboundMutation, rejectNonLocalRequest } from "@/server/request-security";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  return Response.json(outboundSlackSettingsService.load());
}

export async function POST(request: Request) {
  const rejection = rejectNonHumanOutboundMutation(request, "outbound-preferences");
  if (rejection) return rejection;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  try {
    const config = getStateStore().saveOutboundChannelConfig(parseOutboundChannelConfig(body));
    return Response.json({ configured: outboundSlackSettingsService.load().configured, config });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Outbound preferences update failed" },
      { status: error instanceof OutboundInputError ? 400 : 500 },
    );
  }
}
