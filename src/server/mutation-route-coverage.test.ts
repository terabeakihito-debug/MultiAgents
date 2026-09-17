import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");
const HUMAN_GUARDS = /(?:requireHumanMutation|rejectNonHuman(?:Profile|Template|Finding|Notification|Outbound|Repository)Mutation)\(\s*request/;

describe("Phase 17.6 mutation route coverage", () => {
  it("places every POST/PUT/PATCH/DELETE route behind the common human gate", async () => {
    const routes = await routeFiles(API_ROOT);
    const uncovered: string[] = [];
    for (const route of routes) {
      if (route.includes("[[...segments]]")) continue;
      const source = await readFile(route, "utf8");
      if (/export (?:async )?function (?:POST|PUT|PATCH|DELETE)\b/.test(source) && !HUMAN_GUARDS.test(source)) uncovered.push(route.slice(process.cwd().length + 1));
    }
    expect(uncovered).toEqual([]);
  });
});

async function routeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory() ? routeFiles(join(root, entry.name)) : Promise.resolve(entry.name === "route.ts" ? [join(root, entry.name)] : [])));
  return files.flat();
}
