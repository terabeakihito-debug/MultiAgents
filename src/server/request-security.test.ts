import { describe, expect, it } from "vitest";
import { rejectNonLocalRequest } from "./request-security";

describe("rejectNonLocalRequest", () => {
  it("allows a localhost same-origin request", () => {
    const request = new Request("http://localhost:3000/api/agents/codex", {
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    });
    expect(rejectNonLocalRequest(request)).toBeUndefined();
  });

  it("rejects non-loopback hosts and origins", async () => {
    const badHost = new Request("http://example.test/api/agents/codex", { headers: { host: "example.test" } });
    expect(rejectNonLocalRequest(badHost)?.status).toBe(403);

    const badOrigin = new Request("http://localhost:3000/api/agents/codex", {
      headers: { host: "localhost:3000", origin: "https://example.test" },
    });
    expect(rejectNonLocalRequest(badOrigin)?.status).toBe(403);
  });
});
