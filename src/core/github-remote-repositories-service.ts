import { listGitHubRemoteRepositories } from "../server/github-account";

type GitHubRemoteRepositoriesDependencies = {
  loadRemote: typeof listGitHubRemoteRepositories;
};

export function createGitHubRemoteRepositoriesService(dependencies: GitHubRemoteRepositoriesDependencies = {
  loadRemote: listGitHubRemoteRepositories,
}) {
  return {
    load() {
      return dependencies.loadRemote();
    },
  };
}

/** Framework-independent GitHub remote repository catalog read boundary. */
export const githubRemoteRepositoriesService = createGitHubRemoteRepositoriesService();
