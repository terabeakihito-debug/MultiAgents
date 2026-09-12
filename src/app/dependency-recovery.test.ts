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

  it("uses the existing approval snapshot path and never offers automatic installation", async () => {
    const page = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).toContain("Dependencies required");
    expect(page).toContain("Recheck approval snapshot");
    expect(page).toContain("refreshDiff(task)");
    expect(page).not.toContain("npm install");
  });
});
