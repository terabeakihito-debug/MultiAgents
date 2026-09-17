import { describe, expect, it, vi } from "vitest";
import {
  createOutboundSlackTestMutationService,
  OutboundInputError,
} from "./outbound-slack-test-mutation-service";

describe("outbound slack test mutation service", () => {
  it("returns delivered status when Slack accepts the test", async () => {
    const service = createOutboundSlackTestMutationService({
      send: vi.fn(async () => ({ delivered: true })) as never,
    });

    await expect(service.apply()).resolves.toEqual({
      outcome: "delivered",
      body: { status: "delivered" },
    });
  });

  it("returns failed status when Slack rejects the test", async () => {
    const service = createOutboundSlackTestMutationService({
      send: vi.fn(async () => ({ delivered: false })) as never,
    });

    await expect(service.apply()).resolves.toEqual({
      outcome: "failed",
      body: { error: "Slack test delivery failed", status: "failed" },
    });
  });

  it("propagates configuration errors", async () => {
    const service = createOutboundSlackTestMutationService({
      send: vi.fn(async () => {
        throw new OutboundInputError("Slack credential is not configured.");
      }),
    });

    await expect(service.apply()).rejects.toBeInstanceOf(OutboundInputError);
  });
});
