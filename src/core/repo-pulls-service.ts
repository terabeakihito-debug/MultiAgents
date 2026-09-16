import { listOpenPullRequests } from "../server/pr-review";

export class RepoPullsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoPullsRequestError";
  }
}

type RepoPullsDependencies = {
  listPulls: typeof listOpenPullRequests;
};

export function createRepoPullsService(dependencies: RepoPullsDependencies = {
  listPulls: listOpenPullRequests,
}) {
  return {
    async load(repoId: string) {
      try {
        return { pulls: await dependencies.listPulls(repoId) };
      } catch (error) {
        throw new RepoPullsRequestError(
          error instanceof Error ? error.message : "Could not list pull requests",
        );
      }
    },
  };
}

/** Framework-independent repository pull-request list read boundary used by transport adapters. */
export const repoPullsService = createRepoPullsService();
