import {
  leaveMaintenanceMode,
  lifecycleState,
  OperationUnavailableError,
} from "../server/operation-registry";
import {
  assertActiveServerOwnership,
  drainForMaintenance,
} from "../server/server-lifecycle";

type MaintenanceMutationDependencies = {
  assertOwnership: typeof assertActiveServerOwnership;
  drain: typeof drainForMaintenance;
  leave: typeof leaveMaintenanceMode;
  readState: typeof lifecycleState;
};

export class MaintenanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceInputError";
  }
}

export function createMaintenanceMutationService(
  dependencies: MaintenanceMutationDependencies = {
    assertOwnership: assertActiveServerOwnership,
    drain: drainForMaintenance,
    leave: leaveMaintenanceMode,
    readState: lifecycleState,
  },
) {
  return {
    async apply(body: unknown) {
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as { enabled?: unknown }).enabled !== "boolean"
      ) {
        throw new MaintenanceInputError("Maintenance mode input is invalid");
      }

      dependencies.assertOwnership();
      if ((body as { enabled: boolean }).enabled) {
        await dependencies.drain();
      } else {
        dependencies.leave();
      }
      return { state: dependencies.readState() };
    },
  };
}

/** Framework-independent maintenance mutation boundary used by transport adapters. */
export const maintenanceMutationService = createMaintenanceMutationService();

export function maintenanceMutationErrorStatus(error: unknown) {
  if (error instanceof MaintenanceInputError) return 400;
  if (error instanceof OperationUnavailableError) return 409;
  return 500;
}
