import { initializeTaskRecovery } from "../server/tasks";
import {
  taskCleanupService,
  TaskCleanupRequestError,
  type TaskCleanupRequest,
} from "./task-cleanup-service";

type TaskDeleteMutationDependencies = {
  initialize: typeof initializeTaskRecovery;
  parse: typeof taskCleanupService.parseRequest;
  remove: typeof taskCleanupService.remove;
};

export function createTaskDeleteMutationService(
  dependencies: TaskDeleteMutationDependencies = {
    initialize: initializeTaskRecovery,
    parse: taskCleanupService.parseRequest,
    remove: (id, request) => taskCleanupService.remove(id, request),
  },
) {
  return {
    initialize: dependencies.initialize,
    parseDeleteBody(rawBody: string): TaskCleanupRequest {
      let parsed: unknown;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        throw new TaskCleanupRequestError();
      }
      try {
        return dependencies.parse(parsed);
      } catch (error) {
        if (error instanceof TaskCleanupRequestError) throw error;
        throw error;
      }
    },
    async removeTask(id: string, request: TaskCleanupRequest) {
      await dependencies.remove(id, request);
    },
  };
}

/** Framework-independent task delete mutation used by transport adapters. */
export const taskDeleteMutationService = createTaskDeleteMutationService();

export { TaskCleanupRequestError };
