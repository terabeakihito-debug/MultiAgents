import { getOrCreateRepoProfile } from "../server/project-profiles";

export class RepoProfileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoProfileNotFoundError";
  }
}

type RepoProfileDependencies = {
  loadProfile: typeof getOrCreateRepoProfile;
};

export function createRepoProfileService(dependencies: RepoProfileDependencies = {
  loadProfile: getOrCreateRepoProfile,
}) {
  return {
    async load(repoId: string) {
      try {
        const profile = await dependencies.loadProfile(repoId);
        return { profile };
      } catch (error) {
        throw new RepoProfileNotFoundError(
          error instanceof Error ? error.message : "Profile lookup failed",
        );
      }
    },
  };
}

/** Framework-independent repository profile read boundary used by transport adapters. */
export const repoProfileService = createRepoProfileService();
