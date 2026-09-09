import { describe, expect, it } from "vitest";
import { createOperationRegistryState } from "./operation-registry";

describe("ownership-loss admission state machine", () => {
  it("fails closed until an active ownership predicate is installed", () => {
    const missing = createOperationRegistryState();
    expect(() => missing.beginRegisteredOperation("missing", "mutation")).toThrow("ownership lost");
    const falsePredicate = createOperationRegistryState(() => false);
    expect(() => falsePredicate.beginRegisteredOperation("false", "mutation")).toThrow("ownership lost");
    const active = createOperationRegistryState(() => true);
    const done = active.beginRegisteredOperation("active", "mutation");
    done();
  });

  it("keeps ownership loss after STOPPED and rejects every resumable phase", async () => {
    const registry = createOperationRegistryState(() => true);
    registry.enterOwnershipLost();
    await registry.waitForOperations(0, "STOPPED");
    expect(registry.lifecycleState()).toBe("STOPPED");
    expect(registry.ownershipLostEver()).toBe(true);
    expect(registry.transitionOperationState("MAINTENANCE")).toBe(false);
    expect(registry.transitionOperationState("RUNNING")).toBe(false);
    expect(() => registry.enterMaintenanceMode()).toThrow();
    expect(() => registry.beginRegisteredOperation("after-loss", "mutation")).toThrow();
  });
});
