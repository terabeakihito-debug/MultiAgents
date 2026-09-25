import { describe, expect, it } from "vitest";
import {
  isStaticUiBuildAvailable,
  isViteUiBuildAvailable,
  staticUiIndexHtmlPath,
  viteUiIndexHtmlPath,
} from "./static-ui-artifacts.mjs";

describe("static UI artifacts", () => {
  it("points at next and vite prebuilt index html paths", () => {
    expect(staticUiIndexHtmlPath).toMatch(/\.next\/server\/app\/index\.html$/);
    expect(viteUiIndexHtmlPath).toMatch(/dist-ui\/index\.html$/);
  });

  it("detects vite or next build output in this workspace", async () => {
    expect(await isViteUiBuildAvailable()).toBe(true);
    expect(await isStaticUiBuildAvailable()).toBe(true);
  });
});
