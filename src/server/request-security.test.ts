import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginAgentExecution } from "./agent-execution-guard";
import { clearHumanMutationSessionsForTests, issueHumanMutationNonce, rejectNonLocalRequest, requireHumanMutation } from "./request-security";

const ORIGIN = "http://localhost:3000";

async function issuedNonce(now = 1_000) {
  const response = issueHumanMutationNonce(new Request(`${ORIGIN}/api/human-session`, { headers: {
    host: "localhost:3000", referer: `${ORIGIN}/`, "sec-fetch-site": "same-origin",
  } }), now);
  const body = await response.json() as { nonce: string };
  return { nonce: body.nonce, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

function mutation(headers: Record<string, string> = {}, method = "POST", url = `${ORIGIN}/api/tasks`) {
  return new Request(url, { method, headers: { host: "localhost:3000", ...headers } });
}

function authorizedHeaders(nonce: string, cookie: string, action = "task-create") {
  return {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-multiagents-human-action": action,
    "x-multiagents-human-nonce": nonce,
    cookie,
  };
}

beforeEach(() => {
  clearHumanMutationSessionsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("rejectNonLocalRequest", () => {
  it("allows a localhost read and rejects non-loopback hosts and origins", () => {
    expect(rejectNonLocalRequest(new Request(`${ORIGIN}/api/repos`, { headers: { host: "localhost:3000" } }))).toBeUndefined();
    expect(rejectNonLocalRequest(new Request("http://example.test/api/repos", { headers: { host: "example.test" } }))?.status).toBe(403);
    expect(rejectNonLocalRequest(new Request(`${ORIGIN}/api/repos`, { headers: { host: "localhost:3000", origin: "https://example.test" } }))?.status).toBe(403);
  });
});

describe("requireHumanMutation", () => {
  it("rejects a mutation without Origin", async () => {
    const { nonce, cookie } = await issuedNonce();
    expect(requireHumanMutation(mutation({ "x-multiagents-human-action": "task-create", "x-multiagents-human-nonce": nonce, cookie }), "task-create")?.status).toBe(403);
    const audit = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(audit).toContain("human_gate_rejected");
    expect(audit).not.toContain(nonce);
    expect(audit).not.toContain(ORIGIN);
  });

  it("rejects another localhost port and a non-loopback Origin", async () => {
    const { nonce, cookie } = await issuedNonce();
    expect(requireHumanMutation(mutation({ ...authorizedHeaders(nonce, cookie), origin: "http://localhost:9999" }), "task-create")?.status).toBe(403);
    const issued = await issuedNonce();
    expect(requireHumanMutation(mutation({ ...authorizedHeaders(issued.nonce, issued.cookie), origin: "https://example.test" }), "task-create")?.status).toBe(403);
  });

  it("rejects a missing human action header", async () => {
    const { nonce, cookie } = await issuedNonce();
    const headers = authorizedHeaders(nonce, cookie);
    delete (headers as Partial<typeof headers>)["x-multiagents-human-action"];
    expect(requireHumanMutation(mutation(headers), "task-create")?.status).toBe(403);
  });

  it("rejects invalid and expired nonces", async () => {
    const issued = await issuedNonce();
    expect(requireHumanMutation(mutation(authorizedHeaders("invalid", issued.cookie)), "task-create")?.status).toBe(403);
    const expired = await issuedNonce(10_000);
    expect(requireHumanMutation(mutation(authorizedHeaders(expired.nonce, expired.cookie)), "task-create", { now: 130_001 })?.status).toBe(403);
  });

  it("accepts one valid human mutation and rejects nonce reuse", async () => {
    const { nonce, cookie } = await issuedNonce();
    const request = mutation(authorizedHeaders(nonce, cookie));
    expect(requireHumanMutation(request, "task-create", { now: 2_000 })).toBeUndefined();
    expect(requireHumanMutation(request, "task-create", { now: 2_000 })?.status).toBe(403);
  });

  it("uses the browser Host as the exact origin when the framework normalizes request.url", async () => {
    const browserOrigin = "http://127.0.0.1:3000";
    const nonceResponse = issueHumanMutationNonce(new Request(`${ORIGIN}/api/human-session`, { headers: {
      host: "127.0.0.1:3000", referer: `${browserOrigin}/`, "sec-fetch-site": "same-origin",
    } }), 1_000);
    expect(nonceResponse.status).toBe(200);
    const { nonce } = await nonceResponse.json() as { nonce: string };
    const cookie = nonceResponse.headers.get("set-cookie")!.split(";")[0];
    const request = new Request(`${ORIGIN}/api/tasks`, { method: "POST", headers: {
      host: "127.0.0.1:3000", origin: browserOrigin, "sec-fetch-site": "same-origin",
      "x-multiagents-human-action": "task-create", "x-multiagents-human-nonce": nonce, cookie,
    } });
    expect(requireHumanMutation(request, "task-create", { now: 2_000 })).toBeUndefined();
  });

  it("rejects mutation and nonce issuance while an agent is active", async () => {
    const { nonce, cookie } = await issuedNonce();
    const end = beginAgentExecution();
    try {
      expect(requireHumanMutation(mutation(authorizedHeaders(nonce, cookie)), "task-create", { now: 2_000 })?.status).toBe(423);
      expect(issueHumanMutationNonce(new Request(`${ORIGIN}/api/human-session`, { headers: { host: "localhost:3000", referer: `${ORIGIN}/`, "sec-fetch-site": "same-origin" } }), 2_000).status).toBe(423);
    } finally { end(); }
  });

  it("enforces the method and exact action", async () => {
    const issued = await issuedNonce();
    expect(requireHumanMutation(mutation(authorizedHeaders(issued.nonce, issued.cookie), "DELETE"), "task-create")?.status).toBe(405);
    const next = await issuedNonce();
    expect(requireHumanMutation(mutation(authorizedHeaders(next.nonce, next.cookie, "task-delete")), "task-create")?.status).toBe(403);
  });
});
