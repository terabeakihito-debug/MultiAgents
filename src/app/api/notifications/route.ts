import { NotificationInputError, parseNotificationQuery } from "@/server/notifications";
import { rejectNonLocalRequest } from "@/server/request-security";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  try { return Response.json(getStateStore().queryNotifications(parseNotificationQuery(new URL(request.url)))); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Notification query failed" }, { status: error instanceof NotificationInputError ? 400 : 500 }); }
}
