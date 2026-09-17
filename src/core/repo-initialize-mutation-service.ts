import { initializeLocalProject } from "../server/repositories";

type RepoInitializeMutationDependencies = {
  initialize: typeof initializeLocalProject;
};

export function createRepoInitializeMutationService(
  dependencies: RepoInitializeMutationDependencies = {
    initialize: initializeLocalProject,
  },
) {
  return {
    async apply(repoId: string) {
      const repo = await dependencies.initialize(repoId);
      return { repo };
    },
  };
}

/** Framework-independent repository initialize mutation used by transport adapters. */
export const repoInitializeMutationService =
  createRepoInitializeMutationService();
