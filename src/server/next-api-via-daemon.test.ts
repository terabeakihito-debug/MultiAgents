import { describe, expect, it } from "vitest";
import { createIncomingMessageFromWebRequest } from "./next-api-via-daemon.mjs";

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
});
