import { markAmbiguousDelivery, OutboundInputError } from "@/server/outbound-notifications";
import { rejectNonHumanOutboundMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanOutboundMutation(request, "outbound-dismiss"); if (rejection) return rejection;
  try { return Response.json({ delivery: markAmbiguousDelivery((await context.params).id, "dismissed") }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Slack delivery update failed" }, { status: error instanceof OutboundInputError ? 400 : 500 }); }
}
