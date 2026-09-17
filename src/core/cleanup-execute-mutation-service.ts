import { executeCleanup } from "../server/cleanup";

type CleanupExecuteMutationDependencies = {
  execute: typeof executeCleanup;
};

function candidateIdsFromBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const candidateIds = (body as { candidateIds?: unknown }).candidateIds;
  return Array.isArray(candidateIds) ? (candidateIds as string[]) : [];
}

export function createCleanupExecuteMutationService(
  dependencies: CleanupExecuteMutationDependencies = {
    execute: executeCleanup,
  },
) {
  return {
    async apply(body: unknown) {
      return dependencies.execute(candidateIdsFromBody(body));
    },
  };
}

/** Framework-independent cleanup execute mutation used by transport adapters. */
export const cleanupExecuteMutationService =
  createCleanupExecuteMutationService();
