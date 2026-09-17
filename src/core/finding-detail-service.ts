import { findingHistory } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";

type FindingDetailDependencies = {
  loadFinding: ReturnType<typeof getStateStore>["loadFinding"];
  loadRemediation: typeof getRemediationFinding;
  loadHistory: typeof findingHistory;
};

export class FindingDetailNotFoundError extends Error {
  constructor(message = "Finding not found") {
    super(message);
    this.name = "FindingDetailNotFoundError";
  }
}

export function createFindingDetailService(
  dependencies: FindingDetailDependencies = {
    loadFinding: (id) => getStateStore().loadFinding(id),
    loadRemediation: getRemediationFinding,
    loadHistory: findingHistory,
  },
) {
  return {
    load(id: string) {
      const finding = dependencies.loadFinding(id);
      if (!finding) {
        throw new FindingDetailNotFoundError();
      }
      return {
        finding,
        remediation: dependencies.loadRemediation(id),
        history: dependencies.loadHistory(id),
      };
    },
  };
}

/** Framework-independent finding detail read boundary used by transport adapters. */
export const findingDetailService = createFindingDetailService();
