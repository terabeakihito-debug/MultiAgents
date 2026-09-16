import type { Finding, FindingEvent } from "../findings/types";
import { listTaskFindings } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";
import { initializeTaskRecovery } from "../server/tasks";

export class TaskFindingsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFindingsLoadError";
  }
}

export type TaskFindingView = Finding & {
  remediation: ReturnType<typeof getRemediationFinding>;
  history: FindingEvent[];
};

export type TaskFindingsResult = {
  findings: TaskFindingView[];
};

type TaskFindingsDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  list: typeof listTaskFindings;
  getRemediation: typeof getRemediationFinding;
  loadHistory: (findingId: string) => FindingEvent[];
};

export function createTaskFindingsService(
  dependencies: TaskFindingsDependencies = {
    initializeRecovery: initializeTaskRecovery,
    list: listTaskFindings,
    getRemediation: getRemediationFinding,
    loadHistory: (findingId) => getStateStore().loadFindingEvents(findingId),
  },
) {
  return {
    async load(id: string): Promise<TaskFindingsResult> {
      await dependencies.initializeRecovery();
      try {
        return {
          findings: dependencies.list(id).map((finding) => ({
            ...finding,
            remediation: dependencies.getRemediation(finding.findingId),
            history: dependencies.loadHistory(finding.findingId),
          })),
        };
      } catch (error) {
        throw new TaskFindingsLoadError(
          error instanceof Error ? error.message : "Could not load findings",
        );
      }
    },
  };
}

/** Framework-independent task findings read boundary used by transport adapters. */
export const taskFindingsService = createTaskFindingsService();
