import { latestVerifiedBackup } from "../server/state-backup";
import { getStateStore } from "../server/state-store";

type StateBackupsDependencies = {
  loadBackups: () => ReturnType<ReturnType<typeof getStateStore>["loadBackups"]>;
  loadLatestVerified: typeof latestVerifiedBackup;
};

export function createStateBackupsService(dependencies: StateBackupsDependencies = {
  loadBackups: () => getStateStore().loadBackups(),
  loadLatestVerified: latestVerifiedBackup,
}) {
  return {
    load() {
      return {
        backups: dependencies.loadBackups(),
        latest: dependencies.loadLatestVerified(),
      };
    },
  };
}

/** Framework-independent state backup catalog read boundary used by transport adapters. */
export const stateBackupsService = createStateBackupsService();
