import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./os-sandbox", () => ({ checkOsSandboxAvailability: vi.fn(async () => ({ available: true, backend: "bubblewrap", version: 1 })) }));
vi.mock("./provider-diagnostics", () => ({ providerDiagnostics: vi.fn(async () => [
  { provider: "codex", status: "supported", version: "codex-cli 0.153.4" },
  { provider: "cursor", status: "supported", version: "2026.1" },
  { provider: "claude", status: "supported", version: "2.1" },
]) }));
vi.mock("./server-lifecycle", () => ({ hasActiveServerOwnershipLease: () => true }));

import { operationsOverview } from "./operational-health";
import { StateStore, replaceStateStoreForTests } from "./state-store";
import { clearTasksForTests } from "./tasks";

beforeEach(() => {
  replaceStateStoreForTests(new StateStore(":memory:"));
  clearTasksForTests();
});

describe("Phase 20A operations overview", () => {
  it("returns a path-free deterministic READY overview when local checks are healthy", async () => {
    const store = new StateStore(":memory:");
    replaceStateStoreForTests(store);
    store.saveBackupMetadata({ backupId: crypto.randomUUID(), createdAt: new Date().toISOString(), schemaVersion: 10, integrityStatus: "ok", sizeBytes: 1 });
    const worktreeRoot = await mkdtemp(join(tmpdir(), "multiagents-operations-empty-"));
    const overview = await operationsOverview({ worktreeRoot });
    expect(overview.overall).toBe("ready");
    expect(overview.backup.level).toBe("ok");
    expect(overview.providers.every((item) => item.status === "supported")).toBe(true);
    expect(JSON.stringify(overview)).not.toContain("/home/");
    expect(JSON.stringify(overview)).not.toContain("state.db");
  });

  it("elevates missing backup data without taking any repair action", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "multiagents-operations-empty-"));
    const overview = await operationsOverview({ worktreeRoot });
    expect(overview.overall).toBe("attention");
    expect(overview.backup).toMatchObject({ level: "attention", latest: null });
    expect(overview.nextAction).toBe("Create a verified backup");
  });
});
