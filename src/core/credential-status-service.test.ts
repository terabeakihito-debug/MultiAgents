import { describe, expect, it, vi } from "vitest";
import { createCredentialStatusService } from "./credential-status-service";

describe("credential status service", () => {
  it("loads the audited credential status view", () => {
    const payload = { credentials: [{ capability: "github", status: "ready" }] };
    const loadView = vi.fn(() => payload);
    const service = createCredentialStatusService(
      { loadView } as unknown as Parameters<typeof createCredentialStatusService>[0],
    );

    expect(service.load()).toEqual(payload);
    expect(loadView).toHaveBeenCalledWith(undefined, { audit: true });
  });
});
