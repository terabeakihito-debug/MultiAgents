import { getOrCreateRepoTemplates } from "../server/task-templates";

export class RepoTemplatesNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoTemplatesNotFoundError";
  }
}

type RepoTemplatesDependencies = {
  loadTemplates: typeof getOrCreateRepoTemplates;
};

export function createRepoTemplatesService(dependencies: RepoTemplatesDependencies = {
  loadTemplates: getOrCreateRepoTemplates,
}) {
  return {
    async load(repoId: string) {
      try {
        return await dependencies.loadTemplates(repoId);
      } catch (error) {
        throw new RepoTemplatesNotFoundError(
          error instanceof Error ? error.message : "Task template lookup failed",
        );
      }
    },
  };
}

/** Framework-independent repository templates read boundary used by transport adapters. */
export const repoTemplatesService = createRepoTemplatesService();
