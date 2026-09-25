import { describe, expect, it, vi } from "vitest";
import { createRepoProfileService } from "./repo-profile-service";

describe("repo profile service", () => {
  it("returns the repository profile", async () => {
    const profile = { repoId: "repo-1", profileId: "safe_default" };
    const loadProfile = vi.fn(async () => profile);
    const service = createRepoProfileService(
      { loadProfile } as unknown as Parameters<typeof createRepoProfileService>[0],
    );

    await expect(service.load("repo-1")).resolves.toEqual({ profile });
    expect(loadProfile).toHaveBeenCalledWith("repo-1");
  });

  it("maps lookup failures to RepoProfileNotFoundError", async () => {
    const loadProfile = vi.fn(async () => {
      throw new Error("Repository not found");
    });
    const service = createRepoProfileService(
      { loadProfile } as unknown as Parameters<typeof createRepoProfileService>[0],
    );

    await expect(service.load("missing")).rejects.toMatchObject({
      name: "RepoProfileNotFoundError",
      message: "Repository not found",
    });
  });
});
