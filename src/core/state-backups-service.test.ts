import { describe, expect, it, vi } from "vitest";
import { createStateBackupsService } from "./state-backups-service";

describe("state backups service", () => {
  it("returns backup rows and the latest verified backup", () => {
    const backups = [{ backupId: "b-1" }];
    const latest = { backupId: "b-1", verified: true };
    const loadBackups = vi.fn(() => backups);
    const loadLatestVerified = vi.fn(() => latest);
    const service = createStateBackupsService({
      loadBackups,
      loadLatestVerified,
    } as unknown as Parameters<typeof createStateBackupsService>[0]);

    expect(service.load()).toEqual({ backups, latest });
    expect(loadBackups).toHaveBeenCalledTimes(1);
    expect(loadLatestVerified).toHaveBeenCalledTimes(1);
  });
});
