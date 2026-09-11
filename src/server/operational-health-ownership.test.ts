import { describe, expect, it, vi } from "vitest";

vi.mock("./server-lifecycle", () => ({ hasActiveServerOwnershipLease: () => false }));
vi.mock("./state-store", () => ({ APP_STATE_COMPAT: { minSchema: 9, maxSchema: 13 }, getStateStore: () => ({ schemaVersion: () => 13, integrityCheck: () => "ok", loadUnfinishedOperations: () => [], loadBackups: () => [], loadTasks: () => [], path: "/tmp/absent-state.db" }) }));
vi.mock("./os-sandbox", () => ({ checkOsSandboxAvailability: async () => undefined }));
vi.mock("./provider-diagnostics", () => ({ providerDiagnostics: async () => [] }));
vi.mock("./state-backup", () => ({ latestVerifiedBackup: () => ({ ageHours: 0, schemaVersion: 13, sizeBytes: 1 }) }));
vi.mock("./operation-registry", () => ({ lifecycleState: () => "OWNERSHIP_LOST", activeOperations: () => [], ownershipLostEver: () => true, hasMutationOwnershipPredicate: () => true }));
vi.mock("./tasks", () => ({ listTasks: () => [], WORKTREE_ROOT: "/tmp/multiagents-ownership-health-empty-worktrees" }));

describe("operational health ownership invariant", () => {
  it("never reports ready when every dependency is healthy but ownership is absent", async () => {
    const health = await import("./operational-health");
    const result = await health.healthReadiness();
    expect(result).toMatchObject({ status: "degraded", lifecycle: "OWNERSHIP_LOST", ownership: "lost", nextAction: "Ownership lost — restart required" });
  });
});
