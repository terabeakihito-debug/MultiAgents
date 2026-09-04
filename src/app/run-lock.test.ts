import { describe, expect, it } from "vitest";
import { acquireRunLock, releaseRunLock } from "./run-lock";

describe("run lock", () => {
  it("prevents a duplicate submit until the active run releases it", () => {
    const lock = { current: false };
    expect(acquireRunLock(lock)).toBe(true);
    expect(acquireRunLock(lock)).toBe(false);
    releaseRunLock(lock);
    expect(acquireRunLock(lock)).toBe(true);
  });
});
