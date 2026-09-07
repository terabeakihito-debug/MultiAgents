import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { attentionItems, type OperationsOverviewView } from "./operational-health";

const readyOverview = {
  overall: "ready", nextAction: "No action required", database: { status: "ok" }, backup: { level: "ok", latest: null }, disk: { level: "ok", freeBytes: 1 }, sandbox: { status: "enforced" }, providers: [{ level: "ok" }], reconcileRequired: 0, worktrees: { orphaned: 0 }, outbound: { failed: 0, ambiguous: 0 },
} as unknown as OperationsOverviewView;

describe("Phase 20A.1 Operations UX", () => {
  it("keeps a ready overview free of attention items and puts actionable problems first", () => {
    expect(attentionItems(readyOverview)).toEqual([]);
    const attention = attentionItems({ ...readyOverview, overall: "attention", reconcileRequired: 1, backup: { ...readyOverview.backup, level: "attention" } });
    expect(attention.map((item) => item.key)).toEqual(["reconcile", "backup"]);
  });

  it("uses a dedicated Operations tab panel and keeps task workspace visibility separate", async () => {
    const [dashboard, operations, page] = await Promise.all([readFile(new URL("./task-dashboard.tsx", import.meta.url), "utf8"), readFile(new URL("./operational-health.tsx", import.meta.url), "utf8"), readFile(new URL("./page.tsx", import.meta.url), "utf8")]);
    expect(dashboard).toContain('id="operations-view" role="tabpanel"');
    expect(dashboard).toContain('aria-controls="operations-view"');
    expect(page).toContain('dashboardView === "tasks" ? <>');
    expect(page).toContain('view={dashboardView} onViewChange={setDashboardView}');
    for (const text of ["Loading system status…", "Operations status could not be loaded.", "No operations require attention.", "No orphaned worktrees.", "No failed outbound deliveries.", "aria-expanded", "aria-controls", "aria-modal=\"true\"", "Create Backup", "Enter Maintenance Mode"]) expect(operations).toContain(text);
    expect(operations).not.toContain("worktreePath");
  });
});
