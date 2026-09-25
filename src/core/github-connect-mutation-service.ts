import { connectGitHubWithToken } from "../server/github-account";

type GitHubConnectMutationDependencies = {
  connect: typeof connectGitHubWithToken;
};

function parseConnectBody(body: unknown): string {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { token?: unknown }).token !== "string"
  ) {
    throw new Error("A GitHub personal access token is required");
  }
  return (body as { token: string }).token;
}

export function createGitHubConnectMutationService(dependencies: GitHubConnectMutationDependencies = {
  connect: connectGitHubWithToken,
}) {
  return {
    async apply(body: unknown) {
      const token = parseConnectBody(body);
      const account = await dependencies.connect(token);
      return { account };
    },
  };
}

/** Framework-independent GitHub account connect mutation used by transport adapters. */
export const githubConnectMutationService = createGitHubConnectMutationService();
