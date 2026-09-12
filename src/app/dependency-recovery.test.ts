import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { dependencyRecoveryPresentation } from "./dependency-recovery";

describe("dependency recovery UI presentation", () => {
  it("renders only the fixed server-issued dependency recovery state", () => {
    expect(dependencyRecoveryPresentation({ reason: "dependency_setup_required", recheckAvailable: true })).toEqual({ reason: "dependency_setup_required", recheckAvailable: true });
    expect(dependencyRecoveryPresentation({ reason: "dependency_setup_required", recheckAvailable: false })).toBeUndefined();
    expect(dependencyRecoveryPresentation({ reason: "validation_failed", recheckAvailable: true })).toBeUndefined();
    expect(dependencyRecoveryPresentation(undefined)).toBeUndefined();
  });

  it("keeps managed paths out of initial UI source and requests instructions only after an explicit button action", async () => {
    const page = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).toContain("Dependencies required");
    expect(page).toContain("Show setup command");
    expect(page).toContain("Recheck approval snapshot");
    expect(page).toContain("refreshDiff(task)");
    expect(page).toContain("showSetupCommand(task)");
    expect(page).toContain("/dependency-recovery-instructions");
    expect(page).not.toContain("worktreePath");
    expect(page).not.toContain("&& npm install");
  });
});
