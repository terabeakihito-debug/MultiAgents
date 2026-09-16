import { describe, expect, it, vi } from "vitest";
import { createRepoPullsService, RepoPullsRequestError } from "./repo-pulls-service";

describe("repo pulls service", () => {
  it("returns open pull requests for the repository", async () => {
    const pulls = [{ number: 42, title: "Fix bug" }];
    const listPulls = vi.fn(async () => pulls);
    const service = createRepoPullsService(
      { listPulls } as unknown as Parameters<typeof createRepoPullsService>[0],
    );

    await expect(service.load("repo-1")).resolves.toEqual({ pulls });
    expect(listPulls).toHaveBeenCalledWith("repo-1");
  });

  it("maps listing failures to RepoPullsRequestError", async () => {
    const listPulls = vi.fn(async () => {
      throw new Error("Repository not found");
    });
    const service = createRepoPullsService(
      { listPulls } as unknown as Parameters<typeof createRepoPullsService>[0],
    );

    await expect(service.load("missing")).rejects.toMatchObject({
      name: "RepoPullsRequestError",
      message: "Repository not found",
    });
  });
});
