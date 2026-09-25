import { describe, expect, it } from "vitest";
import { shouldPrepareNextApp } from "./operational-startup-launcher.mjs";

describe("operational startup launcher", () => {
  it("always prepares Next in development for the page handler", () => {
    expect(
      shouldPrepareNextApp({ development: true, staticUiActive: true }),
    ).toBe(true);
    expect(
      shouldPrepareNextApp({ development: true, staticUiActive: false }),
    ).toBe(true);
  });

  it("skips Next prepare in production when static UI build is active", () => {
    expect(
      shouldPrepareNextApp({ development: false, staticUiActive: true }),
    ).toBe(false);
  });

  it("falls back to Next prepare in production without a static UI build", () => {
    expect(
      shouldPrepareNextApp({ development: false, staticUiActive: false }),
    ).toBe(true);
  });
});
