import { convertFinding } from "../server/findings";
import { getRemediationFinding } from "../server/remediation-queue";
import { getStateStore } from "../server/state-store";
import { initializeTaskRecovery, publicTask } from "../server/tasks";

type FindingConvertMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  convert: typeof convertFinding;
  publicTask: typeof publicTask;
  loadRemediation: typeof getRemediationFinding;
  loadFindingEvents: ReturnType<typeof getStateStore>["loadFindingEvents"];
};

export class FindingConvertInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingConvertInputError";
  }
}

function parseConvertBody(body: unknown) {
  const value = body as {
    confirmed?: unknown;
    templateId?: unknown;
    objective?: unknown;
  };
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["confirmed", "templateId", "objective"].includes(key),
    ) ||
    value.confirmed !== true ||
    typeof value.templateId !== "string" ||
    typeof value.objective !== "string"
  ) {
    throw new FindingConvertInputError(
      "Explicit conversion confirmation, template, and objective are required",
    );
  }
  return {
    templateId: value.templateId,
    objective: value.objective,
  };
}

export function createFindingConvertMutationService(
  dependencies: FindingConvertMutationDependencies = {
    initialize: initializeTaskRecovery,
    convert: convertFinding,
    publicTask,
    loadRemediation: getRemediationFinding,
    loadFindingEvents: (findingId) =>
      getStateStore().loadFindingEvents(findingId),
  },
) {
  return {
    async apply(findingId: string, body: unknown) {
      await dependencies.initialize();
      const input = parseConvertBody(body);
      const result = await dependencies.convert(findingId, input);
      return {
        finding: result.finding,
        task: dependencies.publicTask(result.task),
        remediation: dependencies.loadRemediation(result.finding.findingId),
        history: dependencies.loadFindingEvents(result.finding.findingId),
      };
    },
  };
}

/** Framework-independent finding convert mutation used by transport adapters. */
export const findingConvertMutationService =
  createFindingConvertMutationService();
