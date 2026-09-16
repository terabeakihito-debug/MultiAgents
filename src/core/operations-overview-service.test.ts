import { describe, expect, it, vi } from "vitest";
import { createOperationsOverviewService } from "./operations-overview-service";

describe("operations overview service", () => {
  it("loads the operations overview payload", async () => {
    const payload = { overall: "ok", database: { status: "ok" } };
    const load = vi.fn(async () => payload);
    const service = createOperationsOverviewService(
      { load } as unknown as Parameters<typeof createOperationsOverviewService>[0],
    );

    await expect(service.load()).resolves.toEqual(payload);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
