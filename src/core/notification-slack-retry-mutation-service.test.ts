import { describe, expect, it, vi } from "vitest";
import { createNotificationSlackRetryMutationService } from "./notification-slack-retry-mutation-service";

describe("notification slack retry mutation service", () => {
  it("returns the delivery record", async () => {
    const delivery = { deliveryId: "d-1", status: "pending" };
    const service = createNotificationSlackRetryMutationService({
      retry: vi.fn(async () => delivery) as never,
    });

    await expect(service.apply("n-1")).resolves.toEqual({ delivery });
  });
});
