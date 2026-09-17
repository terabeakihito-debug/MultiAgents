import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../../dist-daemon/daemon/http-router.js", () => ({
  createDaemonHttpHandler: () => async (
    _request: IncomingMessage,
    response: ServerResponse,
  ) => {
    response.statusCode = 201;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.write("data: first\n\n");
    await Promise.resolve();
    response.write("data: second\n\n");
    response.end();
  },
}));

import {
  createIncomingMessageFromWebRequest,
  handleNextApiViaDaemon,
} from "./next-api-via-daemon.mjs";

describe("next API via daemon rollback handler", () => {
  it("rewrites /api paths for the daemon router", async () => {
    const request = new Request(
      "http://127.0.0.1:3000/api/operations/providers/refresh",
      { method: "POST", headers: { host: "127.0.0.1:3000" } },
    );

    const incoming = await createIncomingMessageFromWebRequest(request);

    expect(incoming.method).toBe("POST");
    expect(incoming.url).toBe("/operations/providers/refresh");
  });

  it("preserves SSE status and chunks across the Next bridge", async () => {
    const response = await handleNextApiViaDaemon(
      new Request("http://127.0.0.1:3000/api/flows/review/stream", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
  });
});
