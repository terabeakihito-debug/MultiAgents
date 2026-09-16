import { describe, expect, it, vi } from "vitest";
import { createNotificationSlackDeliveryDismissMutationService } from "./notification-slack-delivery-dismiss-mutation-service";

describe("notification slack delivery dismiss mutation service", () => {
  it("returns the delivery record", () => {
    const delivery = { deliveryId: "d-1", status: "suppressed" };
    const service = createNotificationSlackDeliveryDismissMutationService({
      dismissDelivery: vi.fn(() => delivery) as never,
    });

    expect(service.apply("n-1")).toEqual({ delivery });
  });
});
