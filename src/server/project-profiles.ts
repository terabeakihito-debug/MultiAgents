import { randomUUID } from "node:crypto";
import {
  SAFE_APPROVAL_POLICY,
  SAFE_CLEANUP_POLICY,
  SAFE_GIT_POLICY,
  parseProfileSnapshot,
  parseRoles,
  parseValidation,
  safeDefaultSnapshot,
  snapshotProfile,
  type ProjectProfile,
  type ProjectProfileSnapshot,
} from "../profiles/policy";
import { getStateStore } from "./state-store";
import { validateRepository } from "./repositories";

export type ProfileUpdateInput = {
  name: string;
  enabled: boolean;
  roles: unknown;
  validation: unknown;
};

export const BUILT_IN_PRESETS = [{
  id: "safe_default",
  name: "safe_default",
  description: "Isolated implementation with read-only review, explicit approval, required PR, and no merge or deploy.",
  policy: safeDefaultSnapshot("__repository__", "safe_default"),
}] as const;

export function listProjectProfiles() {
  const store = getStateStore();
  return { presets: BUILT_IN_PRESETS, profiles: store.loadProjectProfiles(), versions: store.loadProfileVersions() };
}

export async function getOrCreateRepoProfile(repoId: string, allowedRoot?: string): Promise<ProjectProfile> {
  await validateRepository(repoId, allowedRoot);
  const store = getStateStore();
  const existing = store.loadRepoProfile(repoId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const profile: ProjectProfile = {
    ...safeDefaultSnapshot(repoId, randomUUID()),
    createdAt: now,
    updatedAt: now,
  };
  store.createProjectProfile(profile);
  return profile;
}

export async function updateRepoProfile(repoId: string, input: ProfileUpdateInput, allowedRoot?: string): Promise<ProjectProfile> {
  await validateRepository(repoId, allowedRoot);
  if (!input || typeof input !== "object") throw new Error("Profile input is invalid");
  if (typeof input.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.name)) throw new Error("Profile name is invalid");
  if (typeof input.enabled !== "boolean") throw new Error("Profile enabled state is invalid");
  const roles = parseRoles(input.roles);
  if (roles.cursor === "implement" || roles.claude === "implement") throw new Error("Cursor and Claude implement roles are not available in Phase 10");
  const validation = parseValidation(input.validation);
  const current = await getOrCreateRepoProfile(repoId, allowedRoot);
  const changedFields = (["name", "enabled", "roles", "validation"] as const).filter((field) => JSON.stringify(current[field]) !== JSON.stringify({ name: input.name, enabled: input.enabled, roles, validation }[field]));
  if (!changedFields.length) return current;
  const updated: ProjectProfile = {
    ...current,
    name: input.name,
    enabled: input.enabled,
    roles,
    validation,
    git: { ...SAFE_GIT_POLICY },
    approval: { ...SAFE_APPROVAL_POLICY },
    cleanup: { ...SAFE_CLEANUP_POLICY },
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
  getStateStore().updateProjectProfile(updated, changedFields);
  return updated;
}

export function taskProfileSnapshot(profile: ProjectProfile): ProjectProfileSnapshot {
  return snapshotProfile(profile);
}

export function requireUsableTaskProfile(snapshot: unknown, repoId: string) {
  const parsed = parseProfileSnapshot(snapshot);
  if (parsed.repoId !== repoId) throw new Error("Task profile snapshot repository does not match the task");
  if (!parsed.enabled) throw new Error("Task profile snapshot is disabled");
  return parsed;
}
