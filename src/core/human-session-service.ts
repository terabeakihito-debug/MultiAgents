import { issueHumanMutationNonce } from "../server/request-security";

type HumanSessionDependencies = {
  issue: typeof issueHumanMutationNonce;
};

export function createHumanSessionService(dependencies: HumanSessionDependencies = {
  issue: issueHumanMutationNonce,
}) {
  return {
    issue(request: Request) {
      return dependencies.issue(request);
    },
  };
}

/** Framework-independent human session nonce read boundary used by transport adapters. */
export const humanSessionService = createHumanSessionService();
