import { afterEach, describe, expect, it } from "vitest";
import { acquireTaskLock, clearTaskLocksForTests, isTaskLocked, releaseTaskLock } from "./task-lock";

afterEach(clearTaskLocksForTests);

describe("task lock leases", () => {
  it("only lets the owner release its lease and permits a new owner afterwards", () => {
    const owner = acquireTaskLock("task-a");
    const other = acquireTaskLock("task-b");
    expect(owner).toBeTruthy(); expect(other).toBeTruthy();
    if (!owner || !other) throw new Error("fixture lock unavailable");
    releaseTaskLock("task-a", other);
    expect(isTaskLocked("task-a")).toBe(true);
    expect(isTaskLocked("task-b")).toBe(true);
    releaseTaskLock("task-a", owner);
    releaseTaskLock("task-a", owner);
    expect(isTaskLocked("task-a")).toBe(false);
    expect(acquireTaskLock("task-a")).toBeTruthy();
    expect(isTaskLocked("task-b")).toBe(true);
  });
});
