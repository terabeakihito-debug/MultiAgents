import { describe, expect, it } from "vitest";

describe("production ownership modules", () => {
  it("do not export ownership reset or test predicate controls", async () => {
    const [registry, lifecycle, startup, events, socket] = await Promise.all([
      import("./operation-registry"), import("./server-lifecycle"), import("./operational-startup"), import("./server-ownership-events"), import("./server-ownership-socket.mjs"),
    ]);
    for (const exportsObject of [registry, lifecycle, startup, events, socket]) {
      expect(Object.keys(exportsObject).filter((name) => /(?:reset|ForTests|setMutationOwnershipCheck)/i.test(name))).toEqual([]);
    }
  });
});
