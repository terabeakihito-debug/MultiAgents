import {
  humanPriorities,
  type HumanPriority,
} from "../findings/types";
import { changeFindingPriority } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";
import { initializeTaskRecovery } from "../server/tasks";

type FindingPriorityMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  changePriority: typeof changeFindingPriority;
  loadRemediation: typeof getRemediationFinding;
  loadFindingEvents: ReturnType<typeof getStateStore>["loadFindingEvents"];
};

export class FindingPriorityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingPriorityInputError";
  }
}

function parsePriorityBody(body: unknown): HumanPriority {
  const value = body as { confirmed?: unknown; priority?: unknown };
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["confirmed", "priority"].includes(key)) ||
    value.confirmed !== true ||
    !humanPriorities.includes(value.priority as HumanPriority)
  ) {
    throw new FindingPriorityInputError(
      "Explicit confirmation and a valid human priority are required",
    );
  }
  return value.priority as HumanPriority;
}

export function createFindingPriorityMutationService(
  dependencies: FindingPriorityMutationDependencies = {
    initialize: initializeTaskRecovery,
    changePriority: changeFindingPriority,
    loadRemediation: getRemediationFinding,
    loadFindingEvents: (findingId) =>
      getStateStore().loadFindingEvents(findingId),
  },
) {
  return {
    async apply(findingId: string, body: unknown) {
      await dependencies.initialize();
      const priority = parsePriorityBody(body);
      const finding = dependencies.changePriority(findingId, priority);
      return {
        finding,
        remediation: dependencies.loadRemediation(findingId),
        history: dependencies.loadFindingEvents(findingId),
      };
    },
  };
}

/** Framework-independent finding priority mutation used by transport adapters. */
export const findingPriorityMutationService =
  createFindingPriorityMutationService();
