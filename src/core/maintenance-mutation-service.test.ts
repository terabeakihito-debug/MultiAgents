import { describe, expect, it, vi } from "vitest";
import {
  createMaintenanceMutationService,
  MaintenanceInputError,
} from "./maintenance-mutation-service";

describe("maintenance mutation service", () => {
  it("rejects invalid maintenance input", async () => {
    const service = createMaintenanceMutationService({
      assertOwnership: vi.fn(),
      drain: vi.fn(async () => ({ timedOut: false, remaining: [] })),
      leave: vi.fn(),
      readState: vi.fn(() => "RUNNING" as never),
    });

    await expect(service.apply({ enabled: "yes" })).rejects.toBeInstanceOf(
      MaintenanceInputError,
    );
  });

  it("drains when enabled and leaves when disabled", async () => {
    const drain = vi.fn(async () => ({ timedOut: false, remaining: [] }));
    const leave = vi.fn();
    const readState = vi.fn(() => "MAINTENANCE" as never);
    const service = createMaintenanceMutationService({
      assertOwnership: vi.fn(),
      drain,
      leave,
      readState,
    });

    await expect(service.apply({ enabled: true })).resolves.toEqual({
      state: "MAINTENANCE",
    });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();

    readState.mockReturnValue("RUNNING" as never);
    await expect(service.apply({ enabled: false })).resolves.toEqual({
      state: "RUNNING",
    });
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
