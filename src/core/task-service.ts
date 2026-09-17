import { createTask, initializeTaskRecovery, listTasks, publicTask } from "../server/tasks";

export const MAX_TASK_PROMPT_LENGTH = 20_000;

export type TaskCreateRequest = {
  repoId: string;
  templateId?: string;
  prompt?: string;
  autonomous?: boolean;
};

export type TaskRequestErrorCode =
  | "repository_required"
  | "forbidden_field"
  | "template_invalid"
  | "prompt_invalid";

export class TaskRequestError extends Error {
  constructor(
    readonly code: TaskRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskRequestError";
  }
}

export function parseTaskCreateRequest(input: unknown): TaskCreateRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TaskRequestError("repository_required", "Repository is required");
  }
  const body = input as Record<string, unknown>;
  if (typeof body.repoId !== "string") {
    throw new TaskRequestError("repository_required", "Repository is required");
  }
  if (Object.keys(body).some((key) => !["repoId", "templateId", "prompt", "autonomous"].includes(key))) {
    throw new TaskRequestError("forbidden_field", "Task creation contains a forbidden field");
  }
  if (body.templateId !== undefined && typeof body.templateId !== "string") {
    throw new TaskRequestError("template_invalid", "Task template is invalid");
  }
  if (body.autonomous !== undefined && typeof body.autonomous !== "boolean") {
    throw new TaskRequestError("forbidden_field", "Autonomous execution flag is invalid");
  }
  if (
    body.prompt !== undefined &&
    (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > MAX_TASK_PROMPT_LENGTH)
  ) {
    throw new TaskRequestError("prompt_invalid", "Task prompt must be 1 to 20000 characters");
  }
  return {
    repoId: body.repoId,
    templateId: body.templateId as string | undefined,
    prompt: body.prompt as string | undefined,
    ...(body.autonomous === undefined ? {} : { autonomous: body.autonomous as boolean }),
  };
}

type TaskDependencies = {
  initializeRecovery: typeof initializeTaskRecovery;
  list: typeof listTasks;
  create: typeof createTask;
  toPublic: typeof publicTask;
};

export function createTaskService(dependencies: TaskDependencies = {
  initializeRecovery: initializeTaskRecovery,
  list: listTasks,
  create: createTask,
  toPublic: publicTask,
}) {
  return {
    parseCreateRequest: parseTaskCreateRequest,
    initialize: () => dependencies.initializeRecovery(),
    async list() {
      await dependencies.initializeRecovery();
      return dependencies.list().map(dependencies.toPublic);
    },
    async create(request: TaskCreateRequest) {
      await dependencies.initializeRecovery();
      const task = await dependencies.create(request.repoId, {
        templateId: request.templateId,
        prompt: request.prompt,
        ...(request.autonomous === undefined ? {} : { autonomous: request.autonomous }),
      });
      return dependencies.toPublic(task);
    },
  };
}

/** Framework-independent task collection boundary used by transport adapters. */
export const taskService = createTaskService();
