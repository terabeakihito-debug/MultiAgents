import { describe, expect, it, vi } from "vitest";
import {
  createStateBackupCreateMutationService,
  StateBackupUnavailableError,
} from "./state-backup-create-mutation-service";

describe("state backup create mutation service", () => {
  it("rejects backup creation while draining", async () => {
    const service = createStateBackupCreateMutationService({
      readiness: vi.fn(),
      readLifecycle: vi.fn(() => "DRAINING" as never),
      readActiveOperations: vi.fn(() => []),
      create: vi.fn(),
    });

    await expect(service.create()).rejects.toBeInstanceOf(
      StateBackupUnavailableError,
    );
  });

  it("creates a backup when the server is ready", async () => {
    const backup = { backupId: "b-1", verified: false };
    const create = vi.fn(async () => backup) as never;
    const service = createStateBackupCreateMutationService({
      readiness: vi.fn(),
      readLifecycle: vi.fn(() => "RUNNING" as never),
      readActiveOperations: vi.fn(() => []),
      create,
    });

    await expect(service.create()).resolves.toEqual({ backup });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
