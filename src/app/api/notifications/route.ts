import {
  notificationListService,
  NotificationInputError,
} from "@/core/notification-list-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    return Response.json(
      notificationListService.load(new URL(request.url)),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Notification query failed" },
      { status: error instanceof NotificationInputError ? 400 : 500 },
    );
  }
}
