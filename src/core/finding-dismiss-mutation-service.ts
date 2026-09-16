import { dismissFinding } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";
import { initializeTaskRecovery } from "../server/tasks";

type FindingDismissMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  dismiss: typeof dismissFinding;
  loadRemediation: typeof getRemediationFinding;
  loadFindingEvents: ReturnType<typeof getStateStore>["loadFindingEvents"];
};

export class FindingDismissInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingDismissInputError";
  }
}

function parseDismissBody(body: unknown) {
  const value = body as { confirmed?: unknown; reason?: unknown };
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["confirmed", "reason"].includes(key)) ||
    value.confirmed !== true ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" || value.reason.length > 1_000))
  ) {
    throw new FindingDismissInputError(
      "Explicit dismissal confirmation and an optional short reason are required",
    );
  }
  return value.reason as string | undefined;
}

export function createFindingDismissMutationService(
  dependencies: FindingDismissMutationDependencies = {
    initialize: initializeTaskRecovery,
    dismiss: dismissFinding,
    loadRemediation: getRemediationFinding,
    loadFindingEvents: (findingId) =>
      getStateStore().loadFindingEvents(findingId),
  },
) {
  return {
    async apply(findingId: string, body: unknown) {
      await dependencies.initialize();
      const reason = parseDismissBody(body);
      const finding = dependencies.dismiss(findingId, reason);
      return {
        finding,
        remediation: dependencies.loadRemediation(finding.findingId),
        history: dependencies.loadFindingEvents(finding.findingId),
      };
    },
  };
}

/** Framework-independent finding dismiss mutation used by transport adapters. */
export const findingDismissMutationService =
  createFindingDismissMutationService();
