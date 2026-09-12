import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { heavyVitestFiles, splitVitestFiles } from "./vitest-suite-files";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function findTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTestFiles(path);
    return entry.name.endsWith(".test.ts") ? [relative(projectRoot, path)] : [];
  }));
  return files.flat();
}

describe("Vitest suite partition", () => {
  it("contains exactly the intended heavy files", () => {
    expect(heavyVitestFiles).toEqual([
      "src/server/cleanup.test.ts",
      "src/server/state-store.test.ts",
      "src/server/worktree-reassociation.test.ts",
      "src/server/operational-reliability.test.ts",
      "src/server/child-process-registry.test.ts",
      "src/server/notifications.test.ts",
      "src/server/outbound-notifications.test.ts",
      "src/server/credential-resolver.test.ts",
      "src/server/project-profiles.test.ts",
      "src/server/remediation-queue.test.ts",
    ]);
    expect(new Set(heavyVitestFiles)).toHaveLength(10);
  });

  it("partitions all test files without overlap", async () => {
    const testFiles = (await Promise.all([findTestFiles(join(projectRoot, "src")), findTestFiles(join(projectRoot, "test"))])).flat().sort();
    const { heavy, light } = splitVitestFiles(testFiles);

    expect(heavy.sort()).toEqual([...heavyVitestFiles].sort());
    expect(light).not.toEqual(expect.arrayContaining([...heavyVitestFiles]));
    expect(new Set([...heavy, ...light]).size).toBe(testFiles.length);
    expect([...heavy, ...light].sort()).toEqual(testFiles);
  });
});
