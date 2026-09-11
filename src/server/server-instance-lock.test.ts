import { fork } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeAbstractUnixSocketCapability, reportUnavailableAbstractUnixSocketCapability } from "../../test/abstract-unix-socket-capability";
import { getEffectiveUid, getServerOwnershipSocketName } from "./server-ownership-socket.mjs";
import { acquireServerInstanceLock, SERVER_INSTANCE_SOCKET_NAME, ServerInstanceLockedError } from "./server-instance-lock";

const children: ReturnType<typeof fork>[] = [], directories: string[] = [];
const worker = join(process.cwd(), "src/server/server-instance-lock-worker.mjs");
const capability = await probeAbstractUnixSocketCapability();
reportUnavailableAbstractUnixSocketCapability(capability);
const ownershipDescribe = capability.available ? describe : describe.skip;
function contender(hold = false) {
  const child = fork(worker, [SERVER_INSTANCE_SOCKET_NAME.slice(1), hold ? "hold" : "once"], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child);
  return { child, result: new Promise<{ status: string }>((resolve, reject) => { child.once("message", (value) => resolve(value as { status: string })); child.once("error", reject); }) };
}
async function stop(child: ReturnType<typeof fork>) { child.send("release"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
afterEach(async () => { for (const child of children.splice(0)) if (!child.killed) child.kill("SIGKILL"); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

ownershipDescribe(capability.available ? "abstract Unix socket server ownership" : `abstract Unix socket server ownership [host capability unavailable: ${capability.reason}]`, () => {
  it("rejects a second owner and allows reacquisition after release", async () => {
    const first = await acquireServerInstanceLock(); await expect(acquireServerInstanceLock()).rejects.toBeInstanceOf(ServerInstanceLockedError);
    await first.release(); const replacement = await acquireServerInstanceLock(); await replacement.release();
  });
  it("gives exactly one real-process owner to 24 contenders", async () => {
    const all = await Promise.all(Array.from({ length: 24 }, () => contender(true).result));
    expect(all.filter((value) => value.status === "owner")).toHaveLength(1); expect(all.filter((value) => value.status === "locked")).toHaveLength(23);
  });
  it("releases on SIGKILL without stale recovery", async () => {
    const first = contender(true); expect((await first.result).status).toBe("owner"); expect((await contender().result).status).toBe("locked");
    first.child.kill("SIGKILL"); await new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
    const replacement = contender(true); expect((await replacement.result).status).toBe("owner"); await stop(replacement.child);
  });
  it("keeps ownership when legacy and SQLite pathname artifacts are replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiagents-ownership-artifacts-")); directories.push(directory); const sqlite = join(directory, "server-instance-lock.sqlite");
    await writeFile(sqlite, "legacy"); await rename(sqlite, `${sqlite}.old`); await Promise.all([writeFile(join(directory, "active.json"), "legacy"), writeFile(join(directory, "active-recovery.json"), "legacy")]);
    const first = await acquireServerInstanceLock(); await expect(acquireServerInstanceLock()).rejects.toBeInstanceOf(ServerInstanceLockedError); await first.release();
  });
  it("joins concurrent releases and cannot release a replacement owner", async () => {
    const first = await acquireServerInstanceLock(); const releases = await Promise.all(Array.from({ length: 24 }, () => first.release()));
    expect(releases).toEqual(Array.from({ length: 24 }, () => ({ status: "released" }))); const replacement = await acquireServerInstanceLock();
    await Promise.all(Array.from({ length: 24 }, () => first.release())); await expect(acquireServerInstanceLock()).rejects.toBeInstanceOf(ServerInstanceLockedError); await replacement.release();
  });
  it("closes a still-listening socket after a post-acquisition error", async () => {
    const first = await acquireServerInstanceLock(); first.server.emit("error", new Error("injected"));
    expect(first.isActive()).toBe(false);
    await expect(first.release()).resolves.toMatchObject({ status: expect.stringMatching(/released/) }); expect(first.server.listening).toBe(false);
    const replacement = await acquireServerInstanceLock(); await replacement.release();
  });
});

it("uses one effective-UID socket identity shared with offline restore", async () => {
  const identity = { geteuid: () => 4242, getuid: () => 1 };
  expect(getEffectiveUid(identity)).toBe(4242);
  expect(getServerOwnershipSocketName(identity)).toBe("\0multiagents-server-v1-4242");
  expect(SERVER_INSTANCE_SOCKET_NAME).toBe(getServerOwnershipSocketName());
});
