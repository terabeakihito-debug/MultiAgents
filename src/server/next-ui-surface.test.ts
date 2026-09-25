import { describe, expect, it } from "vitest";
import { createNextStaticUiBridge } from "./next-static-ui-bridge.mjs";

describe("Next UI surface (phase 1)", () => {
  it("uses the Next request handler in development", async () => {
    const bridge = createNextStaticUiBridge({ development: true });
    expect(await bridge.isActive()).toBe(false);
    expect(bridge.shouldFallbackToNextHandler()).toBe(true);
  });

  it("serves prebuilt html in production when next build output exists", async () => {
    const bridge = createNextStaticUiBridge({ development: false });
    expect(await bridge.isActive()).toBe(true);
    expect(bridge.shouldFallbackToNextHandler()).toBe(false);
  });
});
