import { describe, expect, it, vi } from "vitest";
import {
  createRepoTemplatesMutationService,
  RepoTemplatesInputError,
} from "./repo-templates-mutation-service";

describe("repo templates mutation service", () => {
  it("rejects input without explicit confirmation", async () => {
    const service = createRepoTemplatesMutationService({
      update: vi.fn(),
    });

    await expect(
      service.apply("repo-1", { templateId: "bug_fix", enabled: true }),
    ).rejects.toBeInstanceOf(RepoTemplatesInputError);
  });

  it("updates template settings when input is valid", async () => {
    const payload = {
      templates: [{ templateId: "bug_fix", enabled: true }],
      settings: { defaultTemplateId: "bug_fix" },
    };
    const update = vi.fn(async () => payload) as never;
    const service = createRepoTemplatesMutationService({ update });

    await expect(
      service.apply("repo-1", {
        confirmation: true,
        templateId: "bug_fix",
        enabled: true,
      }),
    ).resolves.toEqual(payload);
    expect(update).toHaveBeenCalledWith("repo-1", {
      templateId: "bug_fix",
      enabled: true,
      defaultTemplateId: undefined,
    });
  });
});
