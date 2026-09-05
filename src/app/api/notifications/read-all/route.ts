import { rejectNonHumanNotificationMutation } from "@/server/request-security";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const rejection = rejectNonHumanNotificationMutation(request, "notification-read-all"); if (rejection) return rejection;
  return Response.json({ updated: getStateStore().markAllNotificationsRead() });
}
