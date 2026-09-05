import type { AgentId } from "../agents/types";

export const agentRoles = ["implement", "review_only", "disabled"] as const;
export type AgentRole = (typeof agentRoles)[number];
export type RolePolicy = Record<AgentId, AgentRole>;

export const validationSteps = ["npm_test", "npm_lint", "npm_typecheck", "npm_build"] as const;
export type ValidationStep = (typeof validationSteps)[number];
export const missingScriptPolicies = ["skip", "fail"] as const;
export type MissingScriptPolicy = (typeof missingScriptPolicies)[number];
export const validationTimeoutPresets = ["standard", "extended"] as const;
export type ValidationTimeoutPreset = (typeof validationTimeoutPresets)[number];

export type ValidationPolicy = {
  steps: ValidationStep[];
  missingScript: MissingScriptPolicy;
  timeout: ValidationTimeoutPreset;
};

export type GitPolicy = {
  isolatedWorktreeRequired: true;
  directMainWriteForbidden: true;
  commitRequiresApproval: true;
  prRequired: true;
  mergeAllowedInApp: false;
  forcePushAllowed: false;
  deployAllowedInApp: false;
};

export type ApprovalPolicy = {
  beforeCommit: true;
  beforeRework: true;
  diffHashRequired: true;
  secretScanRequired: true;
  validationRequired: true;
};

export type CleanupPolicy = {
  allowCleanWorktreeRemoval: true;
  allowDirtyWorktreeRemoval: false;
  requireConfirmationIfPrOpen: true;
  requireStrongWarningIfReadyForMerge: true;
};

export type ProjectProfileSnapshot = {
  profileId: string;
  repoId: string;
  name: string;
  version: number;
  enabled: boolean;
  roles: RolePolicy;
  validation: ValidationPolicy;
  git: GitPolicy;
  approval: ApprovalPolicy;
  cleanup: CleanupPolicy;
};

export type ProjectProfile = ProjectProfileSnapshot & {
  createdAt: string;
  updatedAt: string;
};

export const SAFE_GIT_POLICY: GitPolicy = Object.freeze({
  isolatedWorktreeRequired: true,
  directMainWriteForbidden: true,
  commitRequiresApproval: true,
  prRequired: true,
  mergeAllowedInApp: false,
  forcePushAllowed: false,
  deployAllowedInApp: false,
});

export const SAFE_APPROVAL_POLICY: ApprovalPolicy = Object.freeze({
  beforeCommit: true,
  beforeRework: true,
  diffHashRequired: true,
  secretScanRequired: true,
  validationRequired: true,
});

export const SAFE_CLEANUP_POLICY: CleanupPolicy = Object.freeze({
  allowCleanWorktreeRemoval: true,
  allowDirtyWorktreeRemoval: false,
  requireConfirmationIfPrOpen: true,
  requireStrongWarningIfReadyForMerge: true,
});

export const SAFE_DEFAULT_ROLES: RolePolicy = Object.freeze({
  codex: "implement",
  cursor: "review_only",
  claude: "review_only",
});

export const SAFE_DEFAULT_VALIDATION: ValidationPolicy = Object.freeze({
  steps: [...validationSteps],
  missingScript: "skip",
  timeout: "standard",
});

export function safeDefaultSnapshot(repoId: string, profileId = `safe-default-${repoId}`, version = 1): ProjectProfileSnapshot {
  return {
    profileId,
    repoId,
    name: "safe_default",
    version,
    enabled: true,
    roles: { ...SAFE_DEFAULT_ROLES },
    validation: { ...SAFE_DEFAULT_VALIDATION, steps: [...SAFE_DEFAULT_VALIDATION.steps] },
    git: { ...SAFE_GIT_POLICY },
    approval: { ...SAFE_APPROVAL_POLICY },
    cleanup: { ...SAFE_CLEANUP_POLICY },
  };
}

export function snapshotProfile(profile: ProjectProfile): ProjectProfileSnapshot {
  return structuredClone({
    profileId: profile.profileId, repoId: profile.repoId, name: profile.name, version: profile.version,
    enabled: profile.enabled, roles: profile.roles, validation: profile.validation,
    git: profile.git, approval: profile.approval, cleanup: profile.cleanup,
  });
}

export function parseProfileSnapshot(value: unknown): ProjectProfileSnapshot {
  if (!isObject(value)) throw new Error("Task profile snapshot is missing");
  const profileId = requiredId(value.profileId, "profileId");
  const repoId = requiredRepoId(value.repoId);
  const name = requiredName(value.name);
  const version = requiredVersion(value.version);
  if (typeof value.enabled !== "boolean") throw new Error("Profile enabled state is invalid");
  const roles = parseRoles(value.roles);
  const validation = parseValidation(value.validation);
  assertExactSafePolicy(value.git, SAFE_GIT_POLICY, "Git policy");
  assertExactSafePolicy(value.approval, SAFE_APPROVAL_POLICY, "Approval policy");
  assertExactSafePolicy(value.cleanup, SAFE_CLEANUP_POLICY, "Cleanup policy");
  return {
    profileId, repoId, name, version, enabled: value.enabled, roles, validation,
    git: { ...SAFE_GIT_POLICY }, approval: { ...SAFE_APPROVAL_POLICY }, cleanup: { ...SAFE_CLEANUP_POLICY },
  };
}

export function parseRoles(value: unknown): RolePolicy {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "claude,codex,cursor") throw new Error("Role policy must define exactly Codex, Cursor, and Claude");
  const result = {} as RolePolicy;
  for (const id of ["codex", "cursor", "claude"] as const) {
    if (typeof value[id] !== "string" || !agentRoles.includes(value[id] as AgentRole)) throw new Error(`Invalid role for ${id}`);
    result[id] = value[id] as AgentRole;
  }
  return result;
}

export function parseValidation(value: unknown): ValidationPolicy {
  if (!isObject(value)) throw new Error("Validation policy is invalid");
  if (Object.keys(value).sort().join(",") !== "missingScript,steps,timeout") throw new Error("Validation policy contains a forbidden field");
  if (!Array.isArray(value.steps) || value.steps.some((step) => typeof step !== "string" || !validationSteps.includes(step as ValidationStep))) {
    throw new Error("Validation steps must use the server allowlist");
  }
  const steps = value.steps as ValidationStep[];
  if (!steps.length) throw new Error("At least one validation step is required");
  if (new Set(steps).size !== steps.length) throw new Error("Validation steps must be unique");
  if (typeof value.missingScript !== "string" || !missingScriptPolicies.includes(value.missingScript as MissingScriptPolicy)) throw new Error("Invalid missing-script policy");
  if (typeof value.timeout !== "string" || !validationTimeoutPresets.includes(value.timeout as ValidationTimeoutPreset)) throw new Error("Invalid validation timeout preset");
  return { steps: [...steps], missingScript: value.missingScript as MissingScriptPolicy, timeout: value.timeout as ValidationTimeoutPreset };
}

export function validationScript(step: ValidationStep): "test" | "lint" | "typecheck" | "build" {
  return ({ npm_test: "test", npm_lint: "lint", npm_typecheck: "typecheck", npm_build: "build" } as const)[step];
}

const STANDARD_TIMEOUTS = { test: 60_000, lint: 60_000, typecheck: 60_000, build: 120_000 } as const;
export function validationTimeoutMs(script: keyof typeof STANDARD_TIMEOUTS, preset: ValidationTimeoutPreset) {
  return STANDARD_TIMEOUTS[script] * (preset === "extended" ? 2 : 1);
}

function requiredId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) throw new Error(`Profile ${label} is invalid`);
  return value;
}
function requiredRepoId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error("Profile repoId is invalid");
  return value;
}
function requiredName(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error("Profile name is invalid");
  return value;
}
function requiredVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Profile version is invalid");
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function assertExactSafePolicy(value: unknown, expected: object, label: string) {
  if (!isObject(value) || JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`${label} contains a forbidden value`);
}
