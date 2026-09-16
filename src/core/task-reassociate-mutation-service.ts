import { publicTask, reassociateManagedWorktree } from "../server/tasks";

type TaskReassociateMutationDependencies = {
  reassociate: typeof reassociateManagedWorktree;
  toPublicTask: typeof publicTask;
};

export class TaskReassociateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskReassociateInputError";
  }
}

function parseReassociateBody(body: unknown) {
  const value = body as { confirmed?: unknown; fingerprint?: unknown };
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(value).length !== 2 ||
    value.confirmed !== true ||
    typeof value.fingerprint !== "string"
  ) {
    throw new TaskReassociateInputError(
      "Explicit confirmation and preview fingerprint are required",
    );
  }
  return value.fingerprint;
}

export function createTaskReassociateMutationService(
  dependencies: TaskReassociateMutationDependencies = {
    reassociate: reassociateManagedWorktree,
    toPublicTask: publicTask,
  },
) {
  return {
    async apply(taskId: string, body: unknown) {
      const fingerprint = parseReassociateBody(body);
      const task = await dependencies.reassociate(taskId, fingerprint);
      return { task: dependencies.toPublicTask(task) };
    },
  };
}

/** Framework-independent task reassociate mutation used by transport adapters. */
export const taskReassociateMutationService =
  createTaskReassociateMutationService();
