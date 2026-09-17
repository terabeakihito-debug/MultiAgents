import { describe, expect, it, vi } from "vitest";
import { createNotificationSlackMarkDeliveredMutationService } from "./notification-slack-mark-delivered-mutation-service";

describe("notification slack mark-delivered mutation service", () => {
  it("returns the delivery record", () => {
    const delivery = { deliveryId: "d-1", status: "delivered" };
    const service = createNotificationSlackMarkDeliveredMutationService({
      markDelivered: vi.fn(() => delivery) as never,
    });

    expect(service.apply("n-1")).toEqual({ delivery });
  });
});
