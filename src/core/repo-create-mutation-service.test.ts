import { describe, expect, it, vi } from "vitest";
import {
  createRepoCreateMutationService,
  RepoCreateInputError,
} from "./repo-create-mutation-service";

describe("repo create mutation service", () => {
  it("requires a valid project name", async () => {
    const service = createRepoCreateMutationService({
      create: vi.fn(),
      loadProfile: vi.fn(),
      loadTemplates: vi.fn(),
    });

    await expect(service.apply({})).rejects.toBeInstanceOf(RepoCreateInputError);
  });

  it("returns repo payload with needsInitialCommit", async () => {
    const service = createRepoCreateMutationService({
      create: vi.fn(async () => ({ id: "repo-1", name: "my-proj" })) as never,
      loadProfile: vi.fn(async () => ({ profileId: "safe_default" })) as never,
      loadTemplates: vi.fn(async () => ({ templates: [], settings: {} })) as never,
    });

    await expect(
      service.apply({ projectName: "my-proj", createReadme: true }),
    ).resolves.toEqual({
      repo: {
        id: "repo-1",
        name: "my-proj",
        profile: { profileId: "safe_default" },
        templates: [],
        settings: {},
      },
      needsInitialCommit: true,
    });
  });
});
