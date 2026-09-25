import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapPathnameToViteAppHtml,
  mapPathnameToViteAsset,
  parseRequestPathname,
  resolvePathUnderRoot,
} from "./next-static-ui-bridge.mjs";

describe("static UI bridge", () => {
  it("maps vite app routes to prebuilt html files", () => {
    expect(mapPathnameToViteAppHtml("/")).toMatch(/dist-ui\/index\.html$/);
    expect(mapPathnameToViteAppHtml("/p2-mock/")).toMatch(/dist-ui\/p2-mock\.html$/);
    expect(mapPathnameToViteAppHtml("/unknown")).toBeNull();
  });

  it("maps vite assets under dist-ui", () => {
    expect(mapPathnameToViteAsset("/assets/index-abc.js")).toMatch(
      /dist-ui\/assets\/index-abc\.js$/,
    );
    expect(mapPathnameToViteAsset("/tasks")).toBeNull();
  });

  it("rejects path traversal outside the static root", () => {
    const root = join(process.cwd(), "dist-ui");
    expect(resolvePathUnderRoot(root, "assets/index.js")).toBeTruthy();
    expect(resolvePathUnderRoot(root, "../server.mjs")).toBeNull();
  });

  it("parses pathname without query string", () => {
    expect(parseRequestPathname({ url: "/p2-mock?tab=1" } as import("node:http").IncomingMessage)).toBe(
      "/p2-mock",
    );
  });
});
