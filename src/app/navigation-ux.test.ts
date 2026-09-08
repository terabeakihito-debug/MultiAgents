import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("./task-dashboard.tsx", import.meta.url), "utf8");

describe("Phase 21UX workflow presentation", () => {
  it("defaults to Tasks and exposes the four user-facing areas", () => {
    expect(page).toContain('useState<"tasks" | "findings" | "operations" | "settings">("tasks")');
    for (const label of ["Tasks", "Findings", "Operations", "Settings"]) expect(dashboard).toContain(`>${label}<`);
  });

  it("places Start New Task before attention and task history", () => {
    expect(dashboard.indexOf("startTask")).toBeLessThan(dashboard.indexOf("Needs your attention"));
    expect(dashboard.indexOf("Needs your attention")).toBeLessThan(dashboard.indexOf("Recent tasks"));
    expect(page).toContain("What would you like to work on?");
    expect(page).toContain("Task description");
    expect(page).toContain("Advanced settings");
  });

  it("caps attention and recent lists while putting complete history behind All Tasks", () => {
    expect(dashboard).toContain('slice(0, 5)');
    expect(dashboard).toContain("View all tasks");
    expect(dashboard).toContain("Search and filter all tasks");
  });

  it("uses one primary CTA on attention cards and hides internal metadata", () => {
    expect(dashboard).toContain("attention ? <div className=\"taskCardActions\"");
    expect(dashboard).toContain("Details");
    expect(dashboard).not.toContain("approvalHash");
  });

  it("keeps task detail state in tabs and technical data accessible", () => {
    for (const label of ["Overview", "Changes", "History", "Technical", "Technical details"]) expect(page).toContain(`>${label}<`);
  });

  it("makes read-only review behavior explicit without changing its safety gates", () => {
    expect(page).toContain("No worktree, commit, or PR");
    expect(page).toContain("Show findings");
    expect(page).toContain("Approve & Create PR");
  });

  it("keeps Findings, Operations, and Settings separate", () => {
    expect(dashboard).toContain('view === "findings"');
    expect(dashboard).toContain('view === "operations"');
    expect(dashboard).toContain('view === "settings"');
  });
});
