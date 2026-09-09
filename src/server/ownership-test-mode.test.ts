import { fork } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ownership terminality in test mode", () => {
  it("uses the same terminal singleton semantics as production", async () => {
    const child = fork(join(process.cwd(), "src/server/ownership-production-worker.mjs"), [], {
      env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await expect(new Promise((resolve, reject) => {
      child.once("message", (message) => (message as { status?: string })?.status === "pass" ? resolve(message) : reject(new Error("test-mode ownership fixture failed")));
      child.once("error", reject);
      child.once("exit", (code) => { if (code && code !== 0) reject(new Error(`test-mode ownership fixture exited ${code}`)); });
    })).resolves.toEqual({ status: "pass" });
  });
});
