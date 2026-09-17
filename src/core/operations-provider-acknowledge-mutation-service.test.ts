import { describe, expect, it, vi } from "vitest";
import {
  createOperationsProviderAcknowledgeMutationService,
  OperationsProviderAcknowledgeConflictError,
  OperationsProviderAcknowledgeNotFoundError,
} from "./operations-provider-acknowledge-mutation-service";

describe("operations provider acknowledge mutation service", () => {
  it("rejects unknown providers", async () => {
    const service = createOperationsProviderAcknowledgeMutationService({
      loadDiagnostics: vi.fn(async () => []) as never,
      acknowledge: vi.fn(),
    });

    await expect(service.apply("unknown")).rejects.toBeInstanceOf(
      OperationsProviderAcknowledgeNotFoundError,
    );
  });

  it("acknowledges a supported provider version", async () => {
    const acknowledge = vi.fn();
    const service = createOperationsProviderAcknowledgeMutationService({
      loadDiagnostics: vi.fn(async () => [
        {
          provider: "claude",
          status: "supported",
          version: "1.2.3",
        },
      ]) as never,
      acknowledge,
    });

    await expect(service.apply("claude")).resolves.toEqual({
      provider: "claude",
      version: "1.2.3",
    });
    expect(acknowledge).toHaveBeenCalledWith("claude", "1.2.3");
  });

  it("rejects providers without a passing version", async () => {
    const service = createOperationsProviderAcknowledgeMutationService({
      loadDiagnostics: vi.fn(async () => [
        {
          provider: "claude",
          status: "unsupported",
          version: "1.2.3",
        },
      ]) as never,
      acknowledge: vi.fn(),
    });

    await expect(service.apply("claude")).rejects.toBeInstanceOf(
      OperationsProviderAcknowledgeConflictError,
    );
  });
});
