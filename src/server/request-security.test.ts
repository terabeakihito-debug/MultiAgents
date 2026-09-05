import { describe, expect, it } from "vitest";
import { rejectNonHumanFindingMutation, rejectNonHumanProfileMutation, rejectNonHumanTemplateMutation, rejectNonLocalRequest } from "./request-security";
import { beginAgentExecution } from "./agent-execution-guard";

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

describe("rejectNonHumanProfileMutation", () => {
  it("requires the explicit same-origin browser profile-save signal", () => {
    const agentLike = new Request("http://localhost:3000/api/repos/repo/profile", { method: "POST", headers: { host: "localhost:3000" } });
    expect(rejectNonHumanProfileMutation(agentLike)?.status).toBe(403);
    const humanUi = new Request("http://localhost:3000/api/repos/repo/profile", { method: "POST", headers: {
      host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-multiagents-human-action": "profile-save",
    } });
    expect(rejectNonHumanProfileMutation(humanUi)).toBeUndefined();
    const end = beginAgentExecution();
    expect(rejectNonHumanProfileMutation(humanUi)?.status).toBe(423);
    end();
  });
});

describe("rejectNonHumanTemplateMutation", () => {
  it("allows only the explicit same-origin template UI action and blocks agents", () => {
    const agentLike = new Request("http://localhost:3000/api/repos/repo/templates", { method: "POST", headers: { host: "localhost:3000" } });
    expect(rejectNonHumanTemplateMutation(agentLike)?.status).toBe(403);
    const wrongSignal = new Request("http://localhost:3000/api/repos/repo/templates", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-multiagents-human-action": "profile-save" } });
    expect(rejectNonHumanTemplateMutation(wrongSignal)?.status).toBe(403);
    const humanUi = new Request("http://localhost:3000/api/repos/repo/templates", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-multiagents-human-action": "template-save" } });
    expect(rejectNonHumanTemplateMutation(humanUi)).toBeUndefined();
    const end = beginAgentExecution(); expect(rejectNonHumanTemplateMutation(humanUi)?.status).toBe(423); end();
  });
});

describe("rejectNonHumanFindingMutation", () => {
  it("requires the exact human conversion action and blocks conversion during agent execution", () => {
    const url = "http://localhost:3000/api/findings/11111111-1111-4111-8111-111111111111/convert";
    const direct = new Request(url, { method: "POST", headers: { host: "localhost:3000" } });
    expect(rejectNonHumanFindingMutation(direct, "finding-convert")?.status).toBe(403);
    const wrongAction = new Request(url, { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-multiagents-human-action": "finding-accept" } });
    expect(rejectNonHumanFindingMutation(wrongAction, "finding-convert")?.status).toBe(403);
    const humanUi = new Request(url, { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-multiagents-human-action": "finding-convert" } });
    expect(rejectNonHumanFindingMutation(humanUi, "finding-convert")).toBeUndefined();
    const end = beginAgentExecution();
    expect(rejectNonHumanFindingMutation(humanUi, "finding-convert")?.status).toBe(423);
    end();
  });

  it("requires distinct human signals for priority and resolution", () => {
    const headers = { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
    const priorityUrl = "http://localhost:3000/api/findings/11111111-1111-4111-8111-111111111111/priority";
    const wrong = new Request(priorityUrl, { method: "POST", headers: { ...headers, "x-multiagents-human-action": "finding-resolve" } });
    expect(rejectNonHumanFindingMutation(wrong, "finding-priority")?.status).toBe(403);
    const priority = new Request(priorityUrl, { method: "POST", headers: { ...headers, "x-multiagents-human-action": "finding-priority" } });
    expect(rejectNonHumanFindingMutation(priority, "finding-priority")).toBeUndefined();
    const resolve = new Request(priorityUrl.replace("priority", "resolve"), { method: "POST", headers: { ...headers, "x-multiagents-human-action": "finding-resolve" } });
    expect(rejectNonHumanFindingMutation(resolve, "finding-resolve")).toBeUndefined();
  });
});
