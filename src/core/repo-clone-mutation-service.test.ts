import { describe, expect, it, vi } from "vitest";
import {
  createRepoCloneMutationService,
  RepoCloneInputError,
} from "./repo-clone-mutation-service";

describe("repo clone mutation service", () => {
  it("requires a githubUrl", async () => {
    const service = createRepoCloneMutationService({
      clone: vi.fn(),
      loadProfile: vi.fn(),
      loadTemplates: vi.fn(),
    });

    await expect(service.apply({})).rejects.toBeInstanceOf(RepoCloneInputError);
  });

  it("returns repo with profile and templates", async () => {
    const service = createRepoCloneMutationService({
      clone: vi.fn(async () => ({ id: "repo-1", name: "proj" })) as never,
      loadProfile: vi.fn(async () => ({ profileId: "safe_default" })) as never,
      loadTemplates: vi.fn(async () => ({
        templates: [],
        settings: {},
      })) as never,
    });

    await expect(
      service.apply({ githubUrl: "https://github.com/o/r" }),
    ).resolves.toEqual({
      repo: {
        id: "repo-1",
        name: "proj",
        profile: { profileId: "safe_default" },
        templates: [],
        settings: {},
      },
    });
  });
});
