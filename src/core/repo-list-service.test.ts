import { describe, expect, it, vi } from "vitest";
import { createRepoListService } from "./repo-list-service";

describe("repo list service", () => {
  it("projects each repository with profile and template data", async () => {
    const repo = { id: "repo-1", name: "Repo One" };
    const profile = { repoId: "repo-1", profileId: "safe_default" };
    const templateData = {
      templates: [{ templateId: "bug_fix" }],
      settings: { defaultTemplateId: "bug_fix" },
    };
    const listRepositories = vi.fn(async () => [repo]);
    const getOrCreateRepoProfile = vi.fn(async () => profile);
    const getOrCreateRepoTemplates = vi.fn(async () => templateData);
    const service = createRepoListService({
      listRepositories,
      getOrCreateRepoProfile,
      getOrCreateRepoTemplates,
    } as unknown as Parameters<typeof createRepoListService>[0]);

    await expect(service.load()).resolves.toEqual({
      repos: [{ ...repo, profile, ...templateData }],
    });
    expect(getOrCreateRepoProfile).toHaveBeenCalledWith("repo-1");
    expect(getOrCreateRepoTemplates).toHaveBeenCalledWith("repo-1");
  });
});
