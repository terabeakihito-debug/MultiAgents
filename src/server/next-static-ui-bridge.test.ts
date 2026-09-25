import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapPathnameToAppHtml,
  mapPathnameToStaticAsset,
  parseRequestPathname,
  resolvePathUnderRoot,
} from "./next-static-ui-bridge.mjs";

describe("next static UI bridge", () => {
  it("maps app routes to prebuilt html files", () => {
    expect(mapPathnameToAppHtml("/")).toMatch(/\.next\/server\/app\/index\.html$/);
    expect(mapPathnameToAppHtml("/p2-mock/")).toMatch(/\.next\/server\/app\/p2-mock\.html$/);
  });

  it("maps /_next/static assets under .next/static", () => {
    expect(mapPathnameToStaticAsset("/_next/static/chunks/app.js")).toMatch(
      /\.next\/static\/chunks\/app\.js$/,
    );
    expect(mapPathnameToStaticAsset("/tasks")).toBeNull();
  });

  it("rejects path traversal outside the static root", () => {
    const root = join(process.cwd(), ".next/static");
    expect(resolvePathUnderRoot(root, "chunks/app.js")).toBeTruthy();
    expect(resolvePathUnderRoot(root, "../server/app/index.html")).toBeNull();
  });

  it("parses pathname without query string", () => {
    expect(parseRequestPathname({ url: "/p2-mock?tab=1" } as import("node:http").IncomingMessage)).toBe(
      "/p2-mock",
    );
  });
});
