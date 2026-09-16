import { describe, expect, it, vi } from "vitest";
import { BackupValidationError } from "../server/state-backup";
import { createStateBackupValidateService } from "./state-backup-validate-service";

describe("state backup validate service", () => {
  it("returns verified backup metadata from the validator", () => {
    const backup = {
      backupId: "00000000-0000-4000-8000-000000000001",
      verified: true as const,
    };
    const validate = vi.fn(() => backup);
    const service = createStateBackupValidateService({
      validate,
    } as unknown as Parameters<typeof createStateBackupValidateService>[0]);

    expect(
      service.load("00000000-0000-4000-8000-000000000001"),
    ).toEqual({ backup });
    expect(validate).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("propagates validation errors from the validator", () => {
    const validate = vi.fn(() => {
      throw new BackupValidationError("Backup metadata not found");
    });
    const service = createStateBackupValidateService({ validate });

    expect(() => service.load("00000000-0000-4000-8000-000000000002")).toThrow(
      BackupValidationError,
    );
  });
});
