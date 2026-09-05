import { OutboundInputError, retryOutboundNotification } from "@/server/outbound-notifications";
import { rejectNonHumanOutboundMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanOutboundMutation(request, "outbound-retry"); if (rejection) return rejection;
  try {
    const delivery = await retryOutboundNotification((await context.params).id);
    return Response.json({ delivery });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Slack retry failed" }, { status: error instanceof OutboundInputError ? 400 : 500 });
  }
}
