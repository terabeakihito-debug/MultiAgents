import { describe, expect, it, vi } from "vitest";
import {
  createNotificationListService,
  NotificationInputError,
} from "./notification-list-service";

describe("notification list service", () => {
  it("parses the request URL and queries notifications", () => {
    const query = { unreadOnly: true, limit: 50 };
    const payload = { notifications: [{ id: "n-1" }], unreadCount: 1 };
    const parseQuery = vi.fn(() => query);
    const queryNotifications = vi.fn(() => payload);
    const service = createNotificationListService({
      parseQuery,
      queryNotifications,
    } as unknown as Parameters<typeof createNotificationListService>[0]);
    const url = new URL("http://127.0.0.1/notifications?unreadOnly=true&limit=50");

    expect(service.load(url)).toEqual(payload);
    expect(parseQuery).toHaveBeenCalledWith(url);
    expect(queryNotifications).toHaveBeenCalledWith(query);
  });

  it("propagates invalid query errors", () => {
    const parseQuery = vi.fn(() => {
      throw new NotificationInputError("Invalid notification limit");
    });
    const queryNotifications = vi.fn();
    const service = createNotificationListService({
      parseQuery,
      queryNotifications,
    } as unknown as Parameters<typeof createNotificationListService>[0]);

    expect(() => service.load(new URL("http://127.0.0.1/notifications?limit=0"))).toThrow(
      NotificationInputError,
    );
    expect(queryNotifications).not.toHaveBeenCalled();
  });
});
