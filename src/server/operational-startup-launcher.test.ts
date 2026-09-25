import { describe, expect, it } from "vitest";
import {
  assertStaticUiBuildAvailable,
  STATIC_UI_BUILD_REQUIRED_MESSAGE,
  STATIC_UI_DEV_BOOTSTRAP_FAILED_MESSAGE,
} from "./operational-startup-launcher.mjs";

describe("operational startup launcher", () => {
  it("requires a static UI build before start", () => {
    expect(() => assertStaticUiBuildAvailable({ staticUiActive: false })).toThrow(
      STATIC_UI_BUILD_REQUIRED_MESSAGE,
    );
    expect(() =>
      assertStaticUiBuildAvailable({ staticUiActive: false, development: true }),
    ).toThrow(STATIC_UI_DEV_BOOTSTRAP_FAILED_MESSAGE);
    expect(() => assertStaticUiBuildAvailable({ staticUiActive: true })).not.toThrow();
  });
});
