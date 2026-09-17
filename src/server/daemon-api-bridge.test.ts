import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createDaemonApiBridge,
  isDaemonApiBridgeEnabled,
  stripApiPrefixFromRequestUrl,
} from "./daemon-api-bridge.mjs";

function request(url: string): IncomingMessage {
  return { url, headers: { host: "127.0.0.1:3000" } } as IncomingMessage;
}

describe("daemon API bridge", () => {
  it("rewrites /api paths to daemon paths", () => {
    const incoming = request("/api/tasks?limit=1");
    expect(stripApiPrefixFromRequestUrl(incoming)).toBe(true);
    expect(incoming.url).toBe("/tasks?limit=1");
  });

  it("ignores non-api paths", () => {
    const incoming = request("/tasks");
    expect(stripApiPrefixFromRequestUrl(incoming)).toBe(false);
    expect(incoming.url).toBe("/tasks");
  });

  it("defaults to enabled unless MULTIAGENTS_USE_DAEMON_API=0", () => {
    const previous = process.env.MULTIAGENTS_USE_DAEMON_API;
    delete process.env.MULTIAGENTS_USE_DAEMON_API;
    expect(isDaemonApiBridgeEnabled()).toBe(true);
    process.env.MULTIAGENTS_USE_DAEMON_API = "0";
    expect(isDaemonApiBridgeEnabled()).toBe(false);
    process.env.MULTIAGENTS_USE_DAEMON_API = "1";
    expect(isDaemonApiBridgeEnabled()).toBe(true);
    if (previous === undefined) delete process.env.MULTIAGENTS_USE_DAEMON_API;
    else process.env.MULTIAGENTS_USE_DAEMON_API = previous;
  });

  it("delegates bridged api requests to the daemon handler", async () => {
    const handler = vi.fn(async () => undefined);
    const previous = process.env.MULTIAGENTS_USE_DAEMON_API;
    delete process.env.MULTIAGENTS_USE_DAEMON_API;
    const bridge = createDaemonApiBridge({
      loadHandler: async () => handler,
    });
    const incoming = request("/api/human-session");
    const response = {} as ServerResponse;

    await expect(bridge.tryHandle(incoming, response)).resolves.toBe(true);
    expect(incoming.url).toBe("/human-session");
    expect(handler).toHaveBeenCalledWith(incoming, response);
    if (previous === undefined) delete process.env.MULTIAGENTS_USE_DAEMON_API;
    else process.env.MULTIAGENTS_USE_DAEMON_API = previous;
  });
});
