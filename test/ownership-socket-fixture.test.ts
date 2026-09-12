import { describe, expect, it } from "vitest";
import { createOwnershipSocketFixtureName } from "./ownership-socket-fixture";

describe("ownership socket test fixture identity", () => {
  it("creates distinct test-only abstract socket names", () => {
    const first = createOwnershipSocketFixtureName("first");
    const second = createOwnershipSocketFixtureName("second");
    expect(first).toMatch(/^\0multiagents-test-ownership-first-/);
    expect(second).toMatch(/^\0multiagents-test-ownership-second-/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("multiagents-server-v1-");
  });
});
