import {
  taskService,
  TaskRequestError,
  type TaskCreateRequest,
} from "./task-service";

type TaskCreateMutationDependencies = {
  initialize: typeof taskService.initialize;
  parse: typeof taskService.parseCreateRequest;
  create: typeof taskService.create;
};

export function createTaskCreateMutationService(
  dependencies: TaskCreateMutationDependencies = {
    initialize: () => taskService.initialize(),
    parse: taskService.parseCreateRequest,
    create: (request) => taskService.create(request),
  },
) {
  return {
    initialize: dependencies.initialize,
    async createFromBody(body: unknown) {
      let taskRequest: TaskCreateRequest;
      try {
        taskRequest = dependencies.parse(body);
      } catch (error) {
        if (error instanceof TaskRequestError) throw error;
        throw error;
      }
      return { task: await dependencies.create(taskRequest) };
    },
  };
}

/** Framework-independent task creation mutation used by transport adapters. */
export const taskCreateMutationService = createTaskCreateMutationService();

export { TaskRequestError };
