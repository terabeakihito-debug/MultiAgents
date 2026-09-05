import { NotificationInputError, parseNotificationPreferences } from "@/server/notifications";
import { rejectNonHumanNotificationMutation, rejectNonLocalRequest } from "@/server/request-security";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  return Response.json({ preferences: getStateStore().loadNotificationPreferences() });
}
export async function POST(request: Request) {
  const rejection = rejectNonHumanNotificationMutation(request, "notification-preferences"); if (rejection) return rejection;
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  try { return Response.json({ preferences: getStateStore().saveNotificationPreferences(parseNotificationPreferences(body)) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Preferences update failed" }, { status: error instanceof NotificationInputError ? 400 : 500 }); }
}
