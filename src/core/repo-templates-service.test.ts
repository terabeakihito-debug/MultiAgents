import { describe, expect, it, vi } from "vitest";
import { createRepoTemplatesService } from "./repo-templates-service";

describe("repo templates service", () => {
  it("returns repository template settings", async () => {
    const payload = {
      templates: [{ templateId: "bug_fix" }],
      settings: { defaultTemplateId: "bug_fix" },
    };
    const loadTemplates = vi.fn(async () => payload);
    const service = createRepoTemplatesService(
      { loadTemplates } as unknown as Parameters<typeof createRepoTemplatesService>[0],
    );

    await expect(service.load("repo-1")).resolves.toEqual(payload);
    expect(loadTemplates).toHaveBeenCalledWith("repo-1");
  });

  it("maps lookup failures to RepoTemplatesNotFoundError", async () => {
    const loadTemplates = vi.fn(async () => {
      throw new Error("Repository not found");
    });
    const service = createRepoTemplatesService(
      { loadTemplates } as unknown as Parameters<typeof createRepoTemplatesService>[0],
    );

    await expect(service.load("missing")).rejects.toMatchObject({
      name: "RepoTemplatesNotFoundError",
      message: "Repository not found",
    });
  });
});
