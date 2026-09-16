import { describe, expect, it, vi } from "vitest";
import { createOutboundSlackSettingsService } from "./outbound-slack-settings-service";

describe("outbound slack settings service", () => {
  it("returns the outbound settings view", () => {
    const payload = { configured: true, config: { enabled: true } };
    const loadView = vi.fn(() => payload);
    const service = createOutboundSlackSettingsService(
      { loadView } as unknown as Parameters<typeof createOutboundSlackSettingsService>[0],
    );

    expect(service.load()).toEqual(payload);
    expect(loadView).toHaveBeenCalledTimes(1);
  });
});
