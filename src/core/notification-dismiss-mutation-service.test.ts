import { describe, expect, it, vi } from "vitest";
import { createNotificationDismissMutationService } from "./notification-dismiss-mutation-service";

describe("notification dismiss mutation service", () => {
  it("returns the dismissed notification", () => {
    const notification = { notificationId: "n-1", status: "dismissed" };
    const service = createNotificationDismissMutationService({
      dismiss: vi.fn(() => notification) as never,
    });

    expect(service.apply("n-1")).toBe(notification);
  });

  it("returns undefined when the notification is missing", () => {
    const service = createNotificationDismissMutationService({
      dismiss: vi.fn(() => undefined),
    });

    expect(service.apply("n-1")).toBeUndefined();
  });
});
