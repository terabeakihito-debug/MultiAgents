import { lifecycleState } from "../server/operation-registry";

type MaintenanceStateDependencies = {
  readState: typeof lifecycleState;
};

export function createMaintenanceStateService(dependencies: MaintenanceStateDependencies = {
  readState: lifecycleState,
}) {
  return {
    load() {
      return { state: dependencies.readState() };
    },
  };
}

/** Framework-independent maintenance state read boundary used by transport adapters. */
export const maintenanceStateService = createMaintenanceStateService();
