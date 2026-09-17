import { updateRepoProfile } from "../server/project-profiles";

type RepoProfileMutationDependencies = {
  update: typeof updateRepoProfile;
};

export class RepoProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoProfileInputError";
  }
}

function validateRepoProfileBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RepoProfileInputError("Profile input is invalid");
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set([
    "confirmation",
    "name",
    "enabled",
    "roles",
    "validation",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.confirmation !== true
  ) {
    throw new RepoProfileInputError(
      "Explicit confirmation and only allowlisted profile fields are accepted",
    );
  }
  return value;
}

export function createRepoProfileMutationService(
  dependencies: RepoProfileMutationDependencies = {
    update: updateRepoProfile,
  },
) {
  return {
    async apply(repoId: string, body: unknown) {
      const value = validateRepoProfileBody(body);
      const profile = await dependencies.update(repoId, {
        name: value.name as string,
        enabled: value.enabled as boolean,
        roles: value.roles,
        validation: value.validation,
      });
      return { profile };
    },
  };
}

/** Framework-independent repository profile mutation used by transport adapters. */
export const repoProfileMutationService = createRepoProfileMutationService();
