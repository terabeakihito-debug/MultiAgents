import { getOrCreateRepoProfile } from "../server/project-profiles";
import { listRepositories } from "../server/repositories";
import { getOrCreateRepoTemplates } from "../server/task-templates";

type RepoListDependencies = {
  listRepositories: typeof listRepositories;
  getOrCreateRepoProfile: typeof getOrCreateRepoProfile;
  getOrCreateRepoTemplates: typeof getOrCreateRepoTemplates;
};

export function createRepoListService(dependencies: RepoListDependencies = {
  listRepositories,
  getOrCreateRepoProfile,
  getOrCreateRepoTemplates,
}) {
  return {
    async load() {
      const repos = await dependencies.listRepositories();
      return {
        repos: await Promise.all(
          repos.map(async (repo) => {
            const [profile, templateData] = await Promise.all([
              dependencies.getOrCreateRepoProfile(repo.id),
              dependencies.getOrCreateRepoTemplates(repo.id),
            ]);
            return { ...repo, profile, ...templateData };
          }),
        ),
      };
    },
  };
}

/** Framework-independent repository catalog read boundary used by transport adapters. */
export const repoListService = createRepoListService();
