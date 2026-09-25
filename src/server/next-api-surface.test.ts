import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDaemonApiBridge } from "./daemon-api-bridge.mjs";

async function apiRouteFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? apiRouteFiles(join(root, entry.name))
        : Promise.resolve(entry.name === "route.ts" ? [join(root, entry.name)] : []),
    ),
  );
  return files.flat();
}

describe("Next /api surface (phase 1)", () => {
  it("keeps only the daemon rollback catch-all under src/app/api", async () => {
    const routes = await apiRouteFiles(join(process.cwd(), "src", "app", "api"));
    expect(routes.map((route) => route.replace(`${process.cwd()}/`, ""))).toEqual([
      "src/app/api/[[...segments]]/route.ts",
    ]);
  });

  it("does not handle /api when MULTIAGENTS_USE_DAEMON_API=0 (catch-all rollback required)", async () => {
    const previous = process.env.MULTIAGENTS_USE_DAEMON_API;
    process.env.MULTIAGENTS_USE_DAEMON_API = "0";
    const handler = vi.fn(async () => undefined);
    const bridge = createDaemonApiBridge({ loadHandler: async () => handler });
    const incoming = { url: "/api/health", headers: {} } as IncomingMessage;
    const response = {} as ServerResponse;

    await expect(bridge.tryHandle(incoming, response)).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(incoming.url).toBe("/api/health");

    if (previous === undefined) delete process.env.MULTIAGENTS_USE_DAEMON_API;
    else process.env.MULTIAGENTS_USE_DAEMON_API = previous;
  });
});
