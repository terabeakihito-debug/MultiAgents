import { fork } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ReturnType<typeof fork>[] = [];
afterEach(() => { for (const child of children.splice(0)) if (!child.killed) child.kill("SIGKILL"); });

describe("production ownership reset isolation", () => {
  it("cannot obtain a reset API or reacquire after loss in a production-mode process", async () => {
    const child = fork(join(process.cwd(), "src/server/ownership-production-worker.mjs"), [], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    await expect(new Promise((resolve, reject) => {
      child.once("message", (message) => (message as { status?: string })?.status === "pass" ? resolve(message) : reject(new Error("production ownership fixture failed")));
      child.once("error", reject);
      child.once("exit", (code) => { if (code && code !== 0) reject(new Error(`production ownership fixture exited ${code}`)); });
    })).resolves.toEqual({ status: "pass" });
  });
});
