import { getOrCreateRepoProfile } from "../server/project-profiles";
import { cloneGitHubProject } from "../server/repositories";
import { getOrCreateRepoTemplates } from "../server/task-templates";

type RepoCloneMutationDependencies = {
  clone: typeof cloneGitHubProject;
  loadProfile: typeof getOrCreateRepoProfile;
  loadTemplates: typeof getOrCreateRepoTemplates;
};

export class RepoCloneInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoCloneInputError";
  }
}

function parseCloneBody(body: unknown): string {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { githubUrl?: unknown }).githubUrl !== "string"
  ) {
    throw new RepoCloneInputError("A GitHub repository URL is required");
  }
  return (body as { githubUrl: string }).githubUrl;
}

export function createRepoCloneMutationService(
  dependencies: RepoCloneMutationDependencies = {
    clone: cloneGitHubProject,
    loadProfile: getOrCreateRepoProfile,
    loadTemplates: getOrCreateRepoTemplates,
  },
) {
  return {
    async apply(body: unknown) {
      const githubUrl = parseCloneBody(body);
      const repo = await dependencies.clone(githubUrl);
      const [profile, templateData] = await Promise.all([
        dependencies.loadProfile(repo.id),
        dependencies.loadTemplates(repo.id),
      ]);
      return {
        repo: { ...repo, profile, ...templateData },
      };
    },
  };
}

/** Framework-independent repository clone mutation used by transport adapters. */
export const repoCloneMutationService = createRepoCloneMutationService();
