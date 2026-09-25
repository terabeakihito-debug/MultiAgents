import { describe, expect, it } from "vitest";
import { createNextStaticUiBridge } from "./next-static-ui-bridge.mjs";

describe("Next UI surface (phase 1)", () => {
  it("serves prebuilt html when next build output exists", async () => {
    const bridge = createNextStaticUiBridge();
    expect(await bridge.isActive()).toBe(true);
  });
});
