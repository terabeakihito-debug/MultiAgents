import { approveRework } from "../server/pr-review";
import { ApprovalError } from "../server/pull-request";
import { initializeTaskRecovery } from "../server/tasks";

type TaskApproveReworkMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  approveRework: typeof approveRework;
};

export class TaskApproveReworkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskApproveReworkInputError";
  }
}

function parseApproveReworkBody(body: unknown) {
  const value = body as {
    approved?: unknown;
    diffHash?: unknown;
    approvalId?: unknown;
  };
  if (
    value?.approved !== true ||
    typeof value.diffHash !== "string" ||
    typeof value.approvalId !== "string"
  ) {
    throw new TaskApproveReworkInputError(
      "Explicit approval, diffHash, and approvalId are required",
    );
  }
  return {
    approved: true as const,
    diffHash: value.diffHash,
    approvalId: value.approvalId,
  };
}

export function createTaskApproveReworkMutationService(
  dependencies: TaskApproveReworkMutationDependencies = {
    initialize: initializeTaskRecovery,
    approveRework,
  },
) {
  return {
    async apply(taskId: string, body: unknown) {
      await dependencies.initialize();
      const input = parseApproveReworkBody(body);
      const task = await dependencies.approveRework(taskId, input);
      return { task };
    },
  };
}

/** Framework-independent task approve-rework mutation used by transport adapters. */
export const taskApproveReworkMutationService =
  createTaskApproveReworkMutationService();

export { ApprovalError };
