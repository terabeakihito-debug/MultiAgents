import { describe, expect, it } from "vitest";
import {
  isStaticUiBuildAvailable,
  isViteUiBuildAvailable,
  viteUiIndexHtmlPath,
  viteUiNotFoundHtmlPath,
} from "./static-ui-artifacts.mjs";

describe("static UI artifacts", () => {
  it("points at vite prebuilt html paths", () => {
    expect(viteUiIndexHtmlPath).toMatch(/dist-ui\/index\.html$/);
    expect(viteUiNotFoundHtmlPath).toMatch(/dist-ui\/404\.html$/);
  });

  it("detects vite build output for runtime UI", async () => {
    expect(await isViteUiBuildAvailable()).toBe(true);
    expect(await isStaticUiBuildAvailable()).toBe(true);
  });
});
