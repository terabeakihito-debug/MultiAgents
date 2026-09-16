import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDaemonHttpHandler } from "./http-router";

function request(
  method: string,
  url: string,
): IncomingMessage {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1",
    },
  } as IncomingMessage;
}

function response() {
  const headers = new Map<string, string>();
  let body = "";

  const value = {
    statusCode: 200,
    setHeader(name: string, headerValue: string) {
      headers.set(name.toLowerCase(), headerValue);
      return value;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      return value;
    },
  } as unknown as ServerResponse;

  return {
    value,
    status: () => value.statusCode,
    header: (name: string) => headers.get(name.toLowerCase()),
    json: () => JSON.parse(body) as unknown,
  };
}

function dependencies(
  overrides: Partial<Parameters<typeof createDaemonHttpHandler>[0]> = {},
): Parameters<typeof createDaemonHttpHandler>[0] {
  return {
    health: vi.fn(async () => ({ status: "ready" })) as never,
    listTasks: vi.fn(async () => []),
    ...overrides,
  };
}

describe("daemon HTTP router", () => {
  it("serves the task list through the core task boundary", async () => {
    const tasks = [{ id: "task-1" }, { id: "task-2" }];
    const listTasks = vi.fn(async () => tasks) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("GET", "/tasks"), output.value);

    expect(output.status()).toBe(200);
    expect(output.header("content-type")).toBe("application/json");
    expect(output.header("cache-control")).toBe("no-store");
    expect(output.json()).toEqual({ tasks });
    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error when task listing fails", async () => {
    const listTasks = vi.fn(async () => {
      throw new Error("database failed");
    }) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("GET", "/tasks"), output.value);

    expect(output.status()).toBe(500);
    expect(output.json()).toEqual({ error: "task_list_failed" });
  });

  it("does not expose task listing on unsupported methods", async () => {
    const listTasks = vi.fn(async () => []) as never;
    const handler = createDaemonHttpHandler(
      dependencies({ listTasks }),
    );
    const output = response();

    await handler(request("POST", "/tasks"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
    expect(listTasks).not.toHaveBeenCalled();
  });


  it("rejects a non-loopback Host header", async () => {
    const handler = createDaemonHttpHandler(dependencies());
    const output = response();
    const incoming = request("GET", "/tasks");
    incoming.headers.host = "attacker.example";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "This API is available only on localhost",
    });
  });

  it("rejects a mismatched loopback Origin", async () => {
    const handler = createDaemonHttpHandler(dependencies());
    const output = response();
    const incoming = request("GET", "/tasks");
    incoming.headers.host = "127.0.0.1:3000";
    incoming.headers.origin = "http://127.0.0.1:4000";

    await handler(incoming, output.value);

    expect(output.status()).toBe(403);
    expect(output.json()).toEqual({
      error: "Cross-origin requests are not allowed",
    });
  });

  it("returns 404 for unknown routes", async () => {
    const handler = createDaemonHttpHandler(dependencies());
    const output = response();

    await handler(request("GET", "/unknown"), output.value);

    expect(output.status()).toBe(404);
    expect(output.json()).toEqual({ error: "Not found" });
  });
});
