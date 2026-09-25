import { describe, expect, it } from "vitest";
import {
  isStaticUiBuildAvailable,
  staticUiIndexHtmlPath,
} from "./static-ui-artifacts.mjs";

describe("static UI artifacts", () => {
  it("points at the prebuilt app index html", () => {
    expect(staticUiIndexHtmlPath).toMatch(/\.next\/server\/app\/index\.html$/);
  });

  it("detects an existing next build in this workspace", async () => {
    expect(await isStaticUiBuildAvailable()).toBe(true);
  });
});
