import { deleteTask } from "../server/tasks";

export type TaskCleanupRequest = {
  confirmedPrCleanup?: boolean;
};

export class TaskCleanupRequestError extends Error {
  constructor(message = "Invalid cleanup request") {
    super(message);
    this.name = "TaskCleanupRequestError";
  }
}

export function parseTaskCleanupRequest(input: unknown): TaskCleanupRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TaskCleanupRequestError();
  }
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => key !== "confirmedPrCleanup") ||
    (body.confirmedPrCleanup !== undefined && typeof body.confirmedPrCleanup !== "boolean")
  ) {
    throw new TaskCleanupRequestError();
  }
  return body.confirmedPrCleanup === undefined
    ? {}
    : { confirmedPrCleanup: body.confirmedPrCleanup === true };
}

type TaskCleanupDependencies = {
  remove: typeof deleteTask;
};

export function createTaskCleanupService(dependencies: TaskCleanupDependencies = { remove: deleteTask }) {
  return {
    parseRequest: parseTaskCleanupRequest,
    async remove(id: string, request: TaskCleanupRequest) {
      await dependencies.remove(id, request);
    },
  };
}

/** Framework-independent task cleanup boundary used by transport adapters. */
export const taskCleanupService = createTaskCleanupService();
