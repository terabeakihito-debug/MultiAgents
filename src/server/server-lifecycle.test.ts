import { describe, expect, it } from "vitest";
import { lifecycleState } from "./operation-registry";
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
