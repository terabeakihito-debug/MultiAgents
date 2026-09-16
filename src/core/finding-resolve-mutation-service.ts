import { markFindingResolved } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";
import { initializeTaskRecovery } from "../server/tasks";

type FindingResolveMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  resolve: typeof markFindingResolved;
  loadRemediation: typeof getRemediationFinding;
  loadFindingEvents: ReturnType<typeof getStateStore>["loadFindingEvents"];
};

export class FindingResolveInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingResolveInputError";
  }
}

export function createFindingResolveMutationService(
  dependencies: FindingResolveMutationDependencies = {
    initialize: initializeTaskRecovery,
    resolve: markFindingResolved,
    loadRemediation: getRemediationFinding,
    loadFindingEvents: (findingId) =>
      getStateStore().loadFindingEvents(findingId),
  },
) {
  return {
    async apply(findingId: string, body: unknown) {
      await dependencies.initialize();
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        (body as { confirmed?: unknown }).confirmed !== true
      ) {
        throw new FindingResolveInputError(
          "Explicit resolution confirmation is required",
        );
      }

      const finding = dependencies.resolve(findingId);
      return {
        finding,
        remediation: dependencies.loadRemediation(findingId),
        history: dependencies.loadFindingEvents(findingId),
      };
    },
  };
}

/** Framework-independent finding resolve mutation used by transport adapters. */
export const findingResolveMutationService =
  createFindingResolveMutationService();
