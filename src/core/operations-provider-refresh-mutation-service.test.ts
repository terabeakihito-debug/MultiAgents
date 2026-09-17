import { describe, expect, it, vi } from "vitest";
import { createOperationsProviderRefreshMutationService } from "./operations-provider-refresh-mutation-service";

describe("operations provider refresh mutation service", () => {
  it("returns refreshed provider diagnostics", async () => {
    const providers = [{ provider: "claude", status: "compatible" }];
    const refresh = vi.fn(async () => providers) as never;
    const service = createOperationsProviderRefreshMutationService({ refresh });

    await expect(service.apply()).resolves.toEqual({ providers });
    expect(refresh).toHaveBeenCalledWith({ force: true });
  });
});
