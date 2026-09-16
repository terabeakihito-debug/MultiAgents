import { describe, expect, it, vi } from "vitest";
import { createOutboundSlackSettingsMutationService } from "./outbound-slack-settings-mutation-service";

describe("outbound slack settings mutation service", () => {
  it("parses, saves, and returns the configured view", () => {
    const config = { enabled: true, webhookUrl: "https://hooks.example" };
    const parse = vi.fn(() => config) as never;
    const save = vi.fn(() => config) as never;
    const loadConfigured = vi.fn(() => true);
    const service = createOutboundSlackSettingsMutationService({
      parse,
      save,
      loadConfigured,
    });

    expect(service.apply({ enabled: true })).toEqual({
      configured: true,
      config,
    });
    expect(parse).toHaveBeenCalledWith({ enabled: true });
    expect(save).toHaveBeenCalledWith(config);
  });
});
