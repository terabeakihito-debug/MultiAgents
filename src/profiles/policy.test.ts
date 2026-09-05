import { describe, expect, it } from "vitest";
import { parseProfileSnapshot, parseRoles, parseValidation, safeDefaultSnapshot, validationScript, validationTimeoutMs } from "./policy";

describe("Phase 10 profile policy schema", () => {
  it("creates the safe_default preset with fixed safe policies", () => {
    const profile = safeDefaultSnapshot("MultiAgents", "profile-1");
    expect(profile).toMatchObject({
      name: "safe_default", version: 1, enabled: true,
      roles: { codex: "implement", cursor: "review_only", claude: "review_only" },
      git: { isolatedWorktreeRequired: true, directMainWriteForbidden: true, commitRequiresApproval: true, prRequired: true, mergeAllowedInApp: false, forcePushAllowed: false, deployAllowedInApp: false },
      approval: { beforeCommit: true, beforeRework: true, diffHashRequired: true, secretScanRequired: true, validationRequired: true },
      cleanup: { allowCleanWorktreeRemoval: true, allowDirtyWorktreeRemoval: false, requireConfirmationIfPrOpen: true, requireStrongWarningIfReadyForMerge: true },
    });
  });

  it("accepts only the three fixed role values", () => {
    expect(parseRoles({ codex: "implement", cursor: "review_only", claude: "disabled" }).claude).toBe("disabled");
    expect(() => parseRoles({ codex: "implement", cursor: "write_anywhere", claude: "review_only" })).toThrow("Invalid role");
  });

  it("rejects arbitrary validation commands, binaries, and timeout values", () => {
    expect(() => parseValidation({ steps: ["rm_everything"], missingScript: "skip", timeout: "standard" })).toThrow("allowlist");
    expect(() => parseValidation({ steps: ["npm_test"], missingScript: "skip", timeout: "standard", command: "/bin/sh" })).toThrow("forbidden field");
    expect(() => parseValidation({ steps: ["npm_test"], missingScript: "skip", timeout: 999999 })).toThrow("timeout preset");
  });

  it("maps validation and timeout presets only on the server", () => {
    expect(validationScript("npm_test")).toBe("test");
    expect(validationScript("npm_build")).toBe("build");
    expect(validationTimeoutMs("test", "standard")).toBe(60_000);
    expect(validationTimeoutMs("build", "extended")).toBe(240_000);
  });

  it("rejects attempts to enable merge, deploy, or force push", () => {
    const profile = safeDefaultSnapshot("repo", "profile-1");
    expect(() => parseProfileSnapshot({ ...profile, git: { ...profile.git, mergeAllowedInApp: true } })).toThrow("forbidden value");
    expect(() => parseProfileSnapshot({ ...profile, git: { ...profile.git, deployAllowedInApp: true } })).toThrow("forbidden value");
    expect(() => parseProfileSnapshot({ ...profile, git: { ...profile.git, forcePushAllowed: true } })).toThrow("forbidden value");
  });
});
