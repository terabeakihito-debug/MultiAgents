import { describe, expect, it, vi } from "vitest";
import { createRepoInitializeMutationService } from "./repo-initialize-mutation-service";

describe("repo initialize mutation service", () => {
  it("returns the initialized repo payload", async () => {
    const service = createRepoInitializeMutationService({
      initialize: vi.fn(async () => ({ id: "repo-1", name: "my-proj" })) as never,
    });

    await expect(service.apply("repo-1")).resolves.toEqual({
      repo: { id: "repo-1", name: "my-proj" },
    });
  });
});
