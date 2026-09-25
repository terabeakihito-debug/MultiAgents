import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDaemonApiBridge } from "./daemon-api-bridge.mjs";

async function apiRouteFiles(root: string): Promise<string[]> {
  try {
    await access(root);
  } catch {
    return [];
  }
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
  it("has no App Router handlers under src/app/api", async () => {
    const routes = await apiRouteFiles(join(process.cwd(), "src", "app", "api"));
    expect(routes).toEqual([]);
  });

  it("always delegates /api to the daemon bridge", async () => {
    const handler = vi.fn(async () => undefined);
    const bridge = createDaemonApiBridge({ loadHandler: async () => handler });
    const incoming = { url: "/api/health", headers: {} } as IncomingMessage;
    const response = {} as ServerResponse;

    await expect(bridge.tryHandle(incoming, response)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(incoming, response);
    expect(incoming.url).toBe("/health");
  });
});
