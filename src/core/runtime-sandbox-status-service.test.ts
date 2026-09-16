import { describe, expect, it, vi } from "vitest";
import { createRuntimeSandboxStatusService } from "./runtime-sandbox-status-service";

describe("runtime sandbox status service", () => {
  it("returns enforced status when the OS sandbox is available", async () => {
    const policy = { profile: "agent_read_only" };
    const checkAvailability = vi.fn(async () => ({
      backend: "bubblewrap",
      version: 3,
    }));
    const publicPolicy = vi.fn(() => policy);
    const service = createRuntimeSandboxStatusService({
      checkAvailability,
      publicPolicy,
    } as unknown as Parameters<typeof createRuntimeSandboxStatusService>[0]);

    await expect(service.load()).resolves.toEqual({
      statusCode: 200,
      body: {
        status: "enforced",
        backend: "bubblewrap",
        policyVersion: 3,
        agentReadOnly: policy,
        agentImplement: policy,
        validation: policy,
      },
    });
    expect(publicPolicy).toHaveBeenCalledTimes(3);
  });

  it("returns unavailable status when sandbox checks fail", async () => {
    const checkAvailability = vi.fn(async () => {
      throw Object.assign(new Error("unsupported"), { failureCode: "namespace_unsupported" });
    });
    const publicPolicy = vi.fn();
    const service = createRuntimeSandboxStatusService({
      checkAvailability,
      publicPolicy,
    } as unknown as Parameters<typeof createRuntimeSandboxStatusService>[0]);

    await expect(service.load()).resolves.toEqual({
      statusCode: 503,
      body: {
        status: "unavailable",
        error: "OS sandbox unavailable. Task execution blocked.",
        failureCode: "namespace_unsupported",
      },
    });
    expect(publicPolicy).not.toHaveBeenCalled();
  });
});
