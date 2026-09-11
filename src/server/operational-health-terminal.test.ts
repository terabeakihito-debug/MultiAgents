import { describe, expect, it, vi } from "vitest";

// Simulates an accidental later bind: terminal loss must still dominate it.
vi.mock("./server-lifecycle", () => ({ hasActiveServerOwnershipLease: () => true }));
vi.mock("./state-store", () => ({ APP_STATE_COMPAT: { minSchema: 9, maxSchema: 13 }, getStateStore: () => ({ schemaVersion: () => 13, integrityCheck: () => "ok", loadUnfinishedOperations: () => [], loadBackups: () => [], loadTasks: () => [], path: "/tmp/terminal-state.db" }) }));
vi.mock("./os-sandbox", () => ({ checkOsSandboxAvailability: async () => undefined }));
vi.mock("./provider-diagnostics", () => ({ providerDiagnostics: async () => [] }));
vi.mock("./state-backup", () => ({ latestVerifiedBackup: () => ({ ageHours: 0, schemaVersion: 13, sizeBytes: 1 }) }));
vi.mock("./operation-registry", () => ({ lifecycleState: () => "OWNERSHIP_LOST", activeOperations: () => [], ownershipLostEver: () => true, hasMutationOwnershipPredicate: () => true }));
vi.mock("./tasks", () => ({ listTasks: () => [], WORKTREE_ROOT: "/tmp/multiagents-ownership-health-empty-worktrees" }));

describe("operational health terminal ownership invariant", () => {
  it("never reports ready after terminal ownership loss, even with an active lease", async () => {
    const health = await import("./operational-health");
    await expect(health.healthReadiness()).resolves.toMatchObject({ status: "degraded", lifecycle: "OWNERSHIP_LOST", ownership: "lost", nextAction: "Ownership lost — restart required" });
  });
});
