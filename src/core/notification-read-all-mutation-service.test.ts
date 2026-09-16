import { describe, expect, it, vi } from "vitest";
import { createNotificationReadAllMutationService } from "./notification-read-all-mutation-service";

describe("notification read-all mutation service", () => {
  it("returns the updated count", () => {
    const service = createNotificationReadAllMutationService({
      markAllRead: vi.fn(() => 3),
    });

    expect(service.apply()).toEqual({ updated: 3 });
  });
});
