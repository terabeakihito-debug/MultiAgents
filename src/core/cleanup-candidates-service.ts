import { evaluateCleanupCandidates } from "../server/cleanup";

type CleanupCandidatesDependencies = {
  evaluate: typeof evaluateCleanupCandidates;
};

export function createCleanupCandidatesService(dependencies: CleanupCandidatesDependencies = {
  evaluate: evaluateCleanupCandidates,
}) {
  return {
    load() {
      return dependencies.evaluate();
    },
  };
}

/** Framework-independent cleanup candidates read boundary used by transport adapters. */
export const cleanupCandidatesService = createCleanupCandidatesService();
