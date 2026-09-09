import { vi } from "vitest";

// Most application tests exercise durable workflows rather than the process
// ownership singleton.  Give those workflows an isolated registry instance;
// production singleton and terminality tests run their real module paths in
// dedicated child processes.
vi.mock("../src/server/operation-registry", async () => {
  const actual = await vi.importActual<typeof import("../src/server/operation-registry")>("../src/server/operation-registry");
  const isolated = actual.createOperationRegistryState(() => true);
  return {
    ...actual,
    beginRegisteredOperation: isolated.beginRegisteredOperation,
    canAdmitMutations: isolated.canAdmitMutations,
    activeOperations: isolated.activeOperations,
    hasActiveTaskOperation: isolated.hasActiveTaskOperation,
    lifecycleState: isolated.lifecycleState,
    lifecycleToken: isolated.lifecycleToken,
    transitionOperationState: isolated.transitionOperationState,
    enterMaintenanceMode: isolated.enterMaintenanceMode,
    leaveMaintenanceMode: isolated.leaveMaintenanceMode,
    enterOwnershipLost: isolated.enterOwnershipLost,
    enterDrainingMode: isolated.enterDrainingMode,
    drainOperations: isolated.drainOperations,
    waitForOperations: isolated.waitForOperations,
  };
});
