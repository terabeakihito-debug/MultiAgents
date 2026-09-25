import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { viteAppHtmlFiles } from "./next-static-ui-bridge.mjs";

async function appPageRoutes(): Promise<string[]> {
  const appRoot = join(process.cwd(), "src", "app");
  const routes: string[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, `${prefix}/${entry.name}`);
        continue;
      }
      if (entry.name === "page.tsx") {
        routes.push(prefix || "/");
      }
    }
  }

  await walk(appRoot, "");
  return routes.sort();
}

describe("vite app route coverage", () => {
  it("matches every App Router page with a vite html entry", async () => {
    const pages = await appPageRoutes();
    expect(pages).toEqual(["/", "/p2-mock"]);
    expect(Object.keys(viteAppHtmlFiles).sort()).toEqual(pages);
  });
});
