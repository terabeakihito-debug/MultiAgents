import { updateRepoTemplateSettings } from "../server/task-templates";

type RepoTemplatesMutationDependencies = {
  update: typeof updateRepoTemplateSettings;
};

export class RepoTemplatesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoTemplatesInputError";
  }
}

function validateRepoTemplatesBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RepoTemplatesInputError("Task template settings input is invalid");
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set([
    "confirmation",
    "templateId",
    "enabled",
    "defaultTemplateId",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.confirmation !== true
  ) {
    throw new RepoTemplatesInputError(
      "Explicit confirmation and only allowlisted task template fields are accepted",
    );
  }
  return value;
}

export function createRepoTemplatesMutationService(
  dependencies: RepoTemplatesMutationDependencies = {
    update: updateRepoTemplateSettings,
  },
) {
  return {
    async apply(repoId: string, body: unknown) {
      const value = validateRepoTemplatesBody(body);
      return dependencies.update(repoId, {
        templateId: value.templateId as string | undefined,
        enabled: value.enabled as boolean | undefined,
        defaultTemplateId: value.defaultTemplateId as string | undefined,
      });
    },
  };
}

/** Framework-independent repository template mutation used by transport adapters. */
export const repoTemplatesMutationService =
  createRepoTemplatesMutationService();
