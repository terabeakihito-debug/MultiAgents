import { describe, expect, it } from "vitest";
import {
  assertProductionStaticUiBuild,
  PRODUCTION_STATIC_UI_BUILD_REQUIRED_MESSAGE,
  shouldPrepareNextApp,
} from "./operational-startup-launcher.mjs";

describe("operational startup launcher", () => {
  it("always prepares Next in development for the page handler", () => {
    expect(shouldPrepareNextApp({ development: true })).toBe(true);
  });

  it("skips Next prepare in production", () => {
    expect(shouldPrepareNextApp({ development: false })).toBe(false);
  });

  it("requires a static UI build before production start", () => {
    expect(() =>
      assertProductionStaticUiBuild({
        development: false,
        staticUiActive: false,
      }),
    ).toThrow(PRODUCTION_STATIC_UI_BUILD_REQUIRED_MESSAGE);
    expect(() =>
      assertProductionStaticUiBuild({
        development: true,
        staticUiActive: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionStaticUiBuild({
        development: false,
        staticUiActive: true,
      }),
    ).not.toThrow();
  });
});
