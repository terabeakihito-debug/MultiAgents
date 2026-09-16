import { describe, expect, it, vi } from "vitest";
import { createMaintenanceStateService } from "./maintenance-state-service";

describe("maintenance state service", () => {
  it("returns the current lifecycle state", () => {
    const readState = vi.fn(() => "RUNNING" as const);
    const service = createMaintenanceStateService(
      { readState } as unknown as Parameters<typeof createMaintenanceStateService>[0],
    );

    expect(service.load()).toEqual({ state: "RUNNING" });
    expect(readState).toHaveBeenCalledTimes(1);
  });
});
