import { describe, expect, it, vi } from "vitest";
import { createHumanMutationGateService } from "./human-mutation-gate-service";

describe("human mutation gate service", () => {
  it("delegates to the shared human mutation gate", () => {
    const require = vi.fn(() => undefined);
    const service = createHumanMutationGateService(
      { require } as unknown as Parameters<
        typeof createHumanMutationGateService
      >[0],
    );
    const request = new Request("http://127.0.0.1/maintenance", {
      method: "POST",
    });

    expect(
      service.reject(request, "maintenance-mode", { label: "Maintenance mode" }),
    ).toBeUndefined();
    expect(require).toHaveBeenCalledWith(request, "maintenance-mode", {
      label: "Maintenance mode",
    });
  });
});
