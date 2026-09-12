import { describe, expect, it, vi } from "vitest";
import { lifecycleState } from "./operation-registry";
const ownershipSocketName = vi.hoisted(() => `\0multiagents-test-ownership-server-lifecycle-${process.pid}-${crypto.randomUUID()}`);
vi.mock("./server-ownership-socket.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-ownership-socket.mjs")>();
  return {
    ...actual,
    getServerOwnershipSocketName: (processRef?: NodeJS.Process) => processRef === undefined ? ownershipSocketName : actual.getServerOwnershipSocketName(processRef),
  };
});
import { abortServerStartup, hasActiveServerOwnershipLease, installServerLifecycle } from "./server-lifecycle";
import { probeAbstractUnixSocketCapability, reportUnavailableAbstractUnixSocketCapability } from "../../test/abstract-unix-socket-capability";

const capability = await probeAbstractUnixSocketCapability();
reportUnavailableAbstractUnixSocketCapability(capability);
const ownershipDescribe = capability.available ? describe : describe.skip;

ownershipDescribe(capability.available ? "server ownership lifecycle" : `server ownership lifecycle [host capability unavailable: ${capability.reason}]`, () => {
  it("retries an expected release but makes an unexpected close terminal across reload", async () => {
    const first = await installServerLifecycle();
    await abortServerStartup(first);
    expect(lifecycleState()).toBe("DRAINING");
    const replacement = await installServerLifecycle();
    expect(lifecycleState()).toBe("RUNNING");
    expect(hasActiveServerOwnershipLease()).toBe(true);
    await new Promise<void>((resolve, reject) => replacement.server.close((error) => error ? reject(error) : resolve()));
    expect(lifecycleState()).toBe("OWNERSHIP_LOST");
    expect(hasActiveServerOwnershipLease()).toBe(false);
    await expect(installServerLifecycle()).rejects.toThrow("restart required");
  });
});
