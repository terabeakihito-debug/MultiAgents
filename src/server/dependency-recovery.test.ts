import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { dependencyRecoveryInstructions, shellQuote } from "./dependency-recovery";
import type { RepoTask } from "./tasks";

function task(overrides: Partial<RepoTask> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    worktreePath: "/managed/worktree with spaces/'quoted'",
    dependencyRecovery: "dependency_setup_required",
    recoveryStatus: "recoverable",
    worktreeAvailable: true,
    worktreeStatus: "available",
    ...overrides,
  } as RepoTask;
}

describe("dependency recovery instructions", () => {
  it("returns a shell-safe, task-local setup command only for a recoverable managed worktree", () => {
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
    expect(dependencyRecoveryInstructions(task())).toEqual({
      command: "cd -- '/managed/worktree with spaces/'\\''quoted'\\''' && npm install",
    });
  });

  it.each([
    { dependencyRecovery: undefined },
    { recoveryStatus: "orphaned" as const, worktreeAvailable: false, worktreeStatus: "missing" as const },
    { recoveryStatus: "invalid" as const, worktreeAvailable: false, worktreeStatus: "invalid" as const },
    { worktreeAvailable: false },
    { worktreeStatus: "missing" as const },
  ])("fails closed for unavailable, orphaned, invalid, or non-recovery tasks", (overrides) => {
    expect(dependencyRecoveryInstructions(task(overrides))).toBeUndefined();
  });

  it("does not add a package-manager subprocess", async () => {
    const source = await readFile(new URL("./dependency-recovery.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|\bspawn\(|runHardenedProcess/);
  });
});
