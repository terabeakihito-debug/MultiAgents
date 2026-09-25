import { describe, expect, it } from "vitest";
import {
  shouldPrepareNextApp,
  shouldUseInstrumentationOperationalStartup,
} from "./operational-startup-launcher.mjs";

describe("operational startup launcher", () => {
  it("keeps dev on Next prepare and instrumentation startup", () => {
    expect(
      shouldUseInstrumentationOperationalStartup({ development: true }),
    ).toBe(true);
    expect(
      shouldPrepareNextApp({ development: true, staticUiActive: true }),
    ).toBe(true);
  });

  it("skips Next prepare in production when static UI build is active", () => {
    expect(
      shouldUseInstrumentationOperationalStartup({ development: false }),
    ).toBe(false);
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
