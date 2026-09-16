import { describe, expect, it, vi } from "vitest";
import { createProfileListService } from "./profile-list-service";

const catalog = {
  presets: [{ id: "safe_default" }],
  profiles: [],
  versions: [],
};

describe("profile list service", () => {
  it("returns the project profile catalog", () => {
    const list = vi.fn(() => catalog);
    const service = createProfileListService(
      { list } as unknown as Parameters<typeof createProfileListService>[0],
    );

    expect(service.load()).toEqual(catalog);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
