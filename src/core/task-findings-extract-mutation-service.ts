import { extractTaskFindings } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";
import { initializeTaskRecovery } from "../server/tasks";

type TaskFindingsExtractMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  extract: typeof extractTaskFindings;
  loadRemediation: typeof getRemediationFinding;
  loadFindingEvents: ReturnType<typeof getStateStore>["loadFindingEvents"];
};

export class TaskFindingsExtractInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFindingsExtractInputError";
  }
}

export function createTaskFindingsExtractMutationService(
  dependencies: TaskFindingsExtractMutationDependencies = {
    initialize: initializeTaskRecovery,
    extract: extractTaskFindings,
    loadRemediation: getRemediationFinding,
    loadFindingEvents: (findingId) =>
      getStateStore().loadFindingEvents(findingId),
  },
) {
  return {
    async apply(taskId: string, body: unknown) {
      await dependencies.initialize();
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        (body as { confirmed?: unknown }).confirmed !== true
      ) {
        throw new TaskFindingsExtractInputError(
          "Explicit extraction confirmation is required",
        );
      }

      const findings = await dependencies.extract(taskId);
      return {
        findings: findings.map((finding) => ({
          ...finding,
          remediation: dependencies.loadRemediation(finding.findingId),
          history: dependencies.loadFindingEvents(finding.findingId),
        })),
      };
    },
  };
}

/** Framework-independent task findings extract mutation used by transport adapters. */
export const taskFindingsExtractMutationService =
  createTaskFindingsExtractMutationService();
