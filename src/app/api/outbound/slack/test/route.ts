import { OutboundInputError, sendFixedSlackTest } from "@/server/outbound-notifications";
import { rejectNonHumanOutboundMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = rejectNonHumanOutboundMutation(request, "outbound-test"); if (rejection) return rejection;
  try {
    const result = await sendFixedSlackTest();
    return result.delivered ? Response.json({ status: "delivered" }) : Response.json({ error: "Slack test delivery failed", status: "failed" }, { status: 502 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Slack test delivery failed" }, { status: error instanceof OutboundInputError ? 400 : 500 });
  }
}
