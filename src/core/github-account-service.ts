import { loadGitHubAccount } from "../server/github-account";

type GitHubAccountDependencies = {
  loadAccount: typeof loadGitHubAccount;
};

export function createGitHubAccountService(dependencies: GitHubAccountDependencies = {
  loadAccount: loadGitHubAccount,
}) {
  return {
    load() {
      return dependencies.loadAccount();
    },
  };
}

/** Framework-independent GitHub account read boundary used by transport adapters. */
export const githubAccountService = createGitHubAccountService();
