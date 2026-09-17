import { acceptFinding } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";
import { initializeTaskRecovery } from "../server/tasks";

type FindingAcceptMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  accept: typeof acceptFinding;
  loadRemediation: typeof getRemediationFinding;
  loadFindingEvents: ReturnType<typeof getStateStore>["loadFindingEvents"];
};

export class FindingAcceptInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingAcceptInputError";
  }
}

export function createFindingAcceptMutationService(
  dependencies: FindingAcceptMutationDependencies = {
    initialize: initializeTaskRecovery,
    accept: acceptFinding,
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
        throw new FindingAcceptInputError(
          "Explicit acceptance confirmation is required",
        );
      }

      const finding = dependencies.accept(findingId);
      return {
        finding,
        remediation: dependencies.loadRemediation(finding.findingId),
        history: dependencies.loadFindingEvents(finding.findingId),
      };
    },
  };
}

/** Framework-independent finding accept mutation used by transport adapters. */
export const findingAcceptMutationService =
  createFindingAcceptMutationService();
