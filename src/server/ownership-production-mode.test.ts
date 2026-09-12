import { fork } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeAbstractUnixSocketCapability, reportUnavailableAbstractUnixSocketCapability } from "../../test/abstract-unix-socket-capability";
import { createOwnershipSocketFixtureName } from "../../test/ownership-socket-fixture";

const children: ReturnType<typeof fork>[] = [];
afterEach(() => { for (const child of children.splice(0)) if (!child.killed) child.kill("SIGKILL"); });
const capability = await probeAbstractUnixSocketCapability();
reportUnavailableAbstractUnixSocketCapability(capability);
const ownershipDescribe = capability.available ? describe : describe.skip;

ownershipDescribe(capability.available ? "production ownership reset isolation" : `production ownership reset isolation [host capability unavailable: ${capability.reason}]`, () => {
  it("cannot obtain a reset API or reacquire after loss in a production-mode process", async () => {
    const socketName = createOwnershipSocketFixtureName("ownership-production-mode");
    const child = fork(join(process.cwd(), "src/server/ownership-production-worker.mjs"), [socketName.slice(1)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    await expect(new Promise((resolve, reject) => {
      child.once("message", (message) => (message as { status?: string })?.status === "pass" ? resolve(message) : reject(new Error("production ownership fixture failed")));
      child.once("error", reject);
      child.once("exit", (code) => { if (code && code !== 0) reject(new Error(`production ownership fixture exited ${code}`)); });
    })).resolves.toEqual({ status: "pass" });
  });
});
