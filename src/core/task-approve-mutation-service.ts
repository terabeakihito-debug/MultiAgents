import {
  ApprovalError,
  approveAndCreatePullRequest,
} from "../server/pull-request";
import { initializeTaskRecovery } from "../server/tasks";

type TaskApproveMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  approve: typeof approveAndCreatePullRequest;
};

export class TaskApproveInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskApproveInputError";
  }
}

function parseApproveBody(body: unknown) {
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
    throw new TaskApproveInputError(
      "Explicit approval, diffHash, and approvalId are required",
    );
  }
  return {
    approved: true as const,
    diffHash: value.diffHash,
    approvalId: value.approvalId,
  };
}

export function createTaskApproveMutationService(
  dependencies: TaskApproveMutationDependencies = {
    initialize: initializeTaskRecovery,
    approve: approveAndCreatePullRequest,
  },
) {
  return {
    async apply(taskId: string, body: unknown) {
      await dependencies.initialize();
      const input = parseApproveBody(body);
      const task = await dependencies.approve(taskId, input);
      return { task };
    },
  };
}

/** Framework-independent task approve mutation used by transport adapters. */
export const taskApproveMutationService = createTaskApproveMutationService();

export { ApprovalError };
