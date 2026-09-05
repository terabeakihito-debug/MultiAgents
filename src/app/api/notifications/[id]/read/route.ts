import { rejectNonHumanNotificationMutation } from "@/server/request-security";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanNotificationMutation(request, "notification-read"); if (rejection) return rejection;
  try {
    const notification = getStateStore().markNotificationRead((await context.params).id);
    return notification ? Response.json({ notification }) : Response.json({ error: "Notification not found" }, { status: 404 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Notification update failed" }, { status: 400 }); }
}
