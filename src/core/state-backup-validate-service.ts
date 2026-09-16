import {
  BackupValidationError,
  validateStateBackup,
} from "../server/state-backup";

type StateBackupValidateDependencies = {
  validate: typeof validateStateBackup;
};

export function createStateBackupValidateService(
  dependencies: StateBackupValidateDependencies = {
    validate: validateStateBackup,
  },
) {
  return {
    load(backupId: string) {
      return { backup: dependencies.validate(backupId) };
    },
  };
}

export { BackupValidationError };

/** Framework-independent state backup validation read boundary used by transport adapters. */
export const stateBackupValidateService = createStateBackupValidateService();
