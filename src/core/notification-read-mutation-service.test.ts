import { describe, expect, it, vi } from "vitest";
import { createNotificationReadMutationService } from "./notification-read-mutation-service";

describe("notification read mutation service", () => {
  it("returns the marked notification", () => {
    const notification = { notificationId: "n-1", status: "read" };
    const service = createNotificationReadMutationService({
      markRead: vi.fn(() => notification) as never,
    });

    expect(service.apply("n-1")).toBe(notification);
  });

  it("returns undefined when the notification is missing", () => {
    const service = createNotificationReadMutationService({
      markRead: vi.fn(() => undefined),
    });

    expect(service.apply("n-1")).toBeUndefined();
  });
});
