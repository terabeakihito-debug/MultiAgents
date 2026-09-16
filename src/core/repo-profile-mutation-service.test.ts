import { describe, expect, it, vi } from "vitest";
import {
  createRepoProfileMutationService,
  RepoProfileInputError,
} from "./repo-profile-mutation-service";

describe("repo profile mutation service", () => {
  it("rejects input without explicit confirmation", async () => {
    const service = createRepoProfileMutationService({
      update: vi.fn(),
    });

    await expect(
      service.apply("repo-1", { name: "safe_default", enabled: true }),
    ).rejects.toBeInstanceOf(RepoProfileInputError);
  });

  it("updates a profile when input is valid", async () => {
    const profile = { repoId: "repo-1", profileId: "safe_default" };
    const update = vi.fn(async () => profile) as never;
    const service = createRepoProfileMutationService({ update });

    await expect(
      service.apply("repo-1", {
        confirmation: true,
        name: "safe_default",
        enabled: true,
      }),
    ).resolves.toEqual({ profile });
    expect(update).toHaveBeenCalledWith("repo-1", {
      name: "safe_default",
      enabled: true,
      roles: undefined,
      validation: undefined,
    });
  });
});
