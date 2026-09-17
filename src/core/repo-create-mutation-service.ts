import { getOrCreateRepoProfile } from "../server/project-profiles";
import { createLocalProject } from "../server/repositories";
import { getOrCreateRepoTemplates } from "../server/task-templates";

type RepoCreateMutationDependencies = {
  create: typeof createLocalProject;
  loadProfile: typeof getOrCreateRepoProfile;
  loadTemplates: typeof getOrCreateRepoTemplates;
};

export class RepoCreateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoCreateInputError";
  }
}

function parseCreateBody(body: unknown) {
  const value = body as { projectName?: unknown; createReadme?: unknown };
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["projectName", "createReadme"].includes(key),
    ) ||
    typeof value.projectName !== "string" ||
    (value.createReadme !== undefined &&
      typeof value.createReadme !== "boolean")
  ) {
    throw new RepoCreateInputError("Project name or options are invalid");
  }
  return {
    projectName: value.projectName,
    createReadme: value.createReadme === true,
  };
}

export function createRepoCreateMutationService(
  dependencies: RepoCreateMutationDependencies = {
    create: createLocalProject,
    loadProfile: getOrCreateRepoProfile,
    loadTemplates: getOrCreateRepoTemplates,
  },
) {
  return {
    async apply(body: unknown) {
      const input = parseCreateBody(body);
      const repo = await dependencies.create(
        input.projectName,
        input.createReadme,
      );
      const [profile, templateData] = await Promise.all([
        dependencies.loadProfile(repo.id),
        dependencies.loadTemplates(repo.id),
      ]);
      return {
        repo: { ...repo, profile, ...templateData },
        needsInitialCommit: true as const,
      };
    },
  };
}

/** Framework-independent repository create mutation used by transport adapters. */
export const repoCreateMutationService = createRepoCreateMutationService();
