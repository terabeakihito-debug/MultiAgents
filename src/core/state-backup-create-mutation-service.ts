import { createStateBackup } from "../server/state-backup";
import { databaseReadiness } from "../server/operational-health";
import { activeOperations, lifecycleState } from "../server/operation-registry";

type StateBackupCreateMutationDependencies = {
  readiness: typeof databaseReadiness;
  readLifecycle: typeof lifecycleState;
  readActiveOperations: typeof activeOperations;
  create: typeof createStateBackup;
};

export class StateBackupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateBackupUnavailableError";
  }
}

export function createStateBackupCreateMutationService(
  dependencies: StateBackupCreateMutationDependencies = {
    readiness: databaseReadiness,
    readLifecycle: lifecycleState,
    readActiveOperations: activeOperations,
    create: createStateBackup,
  },
) {
  return {
    async create() {
      dependencies.readiness();
      if (dependencies.readLifecycle() !== "RUNNING") {
        throw new StateBackupUnavailableError(
          "Backups are unavailable while the server is draining",
        );
      }
      if (dependencies.readActiveOperations().length) {
        throw new StateBackupUnavailableError(
          "Backups wait for active operations to finish",
        );
      }
      return { backup: await dependencies.create() };
    },
  };
}

/** Framework-independent state backup create mutation used by transport adapters. */
export const stateBackupCreateMutationService =
  createStateBackupCreateMutationService();
