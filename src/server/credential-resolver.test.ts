import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as credentialStatusGet } from "../app/api/credentials/status/route";
import { credentialStatusView } from "./credential-status";
import {
  CredentialAccessError,
  SecretValue,
  containsKnownSecret,
  createCredentialResolver,
  redactKnownSecrets,
  redactKnownSecretsInValue,
} from "./credential-resolver";
import { StateStore, replaceStateStoreForTests } from "./state-store";

const fixture = "TEST_SECRET_DO_NOT_LEAK";
const webhook = [
  "https://hooks.slack.com/services",
  fixture,
  "CHANNEL",
  "VALUE",
].join("/");

afterEach(() => {
  vi.unstubAllEnvs();
  replaceStateStoreForTests(new StateStore(":memory:"));
});

describe("Phase 16 credential resolver", () => {
  it("resolves a configured Slack credential only for its capability", async () => {
    const resolver = createCredentialResolver({ MULTIAGENTS_SLACK_WEBHOOK_URL: webhook });
    expect(resolver.status("slack_outbound")).toEqual({ capability: "slack_outbound", status: "configured", source: "environment" });
    await expect(resolver.withCredential("slack_outbound", (secret) => secret.revealForCapability("slack_outbound"))).resolves.toBe(webhook);
    await expect(resolver.withCredential("slack_outbound", (secret) => secret.revealForCapability("github_cli"))).rejects.toThrow("capability mismatch");
    let retained: SecretValue | undefined;
    await resolver.withCredential("slack_outbound", (secret) => { retained = secret; });
    expect(() => retained?.revealForCapability("slack_outbound")).toThrow("expired");
  });

  it("reports missing and externally managed credentials without extracting CLI tokens", async () => {
    const resolver = createCredentialResolver({});
    expect(resolver.status("slack_outbound").status).toBe("not_configured");
    expect(resolver.statuses().filter((item) => item.source === "external_cli")).toHaveLength(4);
    await expect(resolver.withCredential("slack_outbound", () => undefined)).rejects.toBeInstanceOf(CredentialAccessError);
    await expect(resolver.withCredential("github_cli", () => undefined)).rejects.toThrow("managed externally");
  });

  it("rejects an invalid capability at runtime", () => {
    const resolver = createCredentialResolver({});
    expect(() => resolver.status("slack_admin" as never)).toThrow("Unsupported credential capability");
  });

  it("redacts string, JSON, primitive coercion, and console-style inspection", () => {
    const secret = new SecretValue("slack_outbound", fixture);
    for (const serialized of [String(secret), `${secret}`, JSON.stringify(secret), inspect(secret)]) {
      expect(serialized).not.toContain(fixture);
      expect(serialized).toContain("REDACTED");
    }
  });

  it("redacts and detects registered known secrets without returning them", () => {
    const environment = { MULTIAGENTS_SLACK_WEBHOOK_URL: fixture };
    expect(containsKnownSecret(`prefix ${fixture} suffix`, environment)).toBe(true);
    expect(redactKnownSecrets(`prefix ${fixture} suffix`, environment)).toBe("prefix [REDACTED_SECRET] suffix");
    expect(redactKnownSecretsInValue({ task: { prompt: fixture }, history: [fixture], count: 1 }, environment)).toEqual({
      task: { prompt: "[REDACTED_SECRET]" }, history: ["[REDACTED_SECRET]"], count: 1,
    });
  });
});

describe("Phase 16 status and persistence boundary", () => {
  it("returns only capability, status, and source from the status API and audits no value", async () => {
    vi.stubEnv("MULTIAGENTS_SLACK_WEBHOOK_URL", webhook);
    const store = new StateStore(":memory:");
    replaceStateStoreForTests(store);
    const response = await credentialStatusGet(new Request("http://localhost:3000/api/credentials/status", { headers: { host: "localhost:3000" } }));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain(fixture);
    expect(JSON.parse(body).credentials).toEqual(expect.arrayContaining([
      { capability: "slack_outbound", status: "configured", source: "environment" },
      { capability: "github_cli", status: "externally_managed", source: "external_cli" },
    ]));
    expect(JSON.stringify(store.loadCredentialAuditEvents())).not.toContain(fixture);
    expect(store.loadCredentialAuditEvents()).toHaveLength(5);
  });

  it("never persists a credential value or secret column", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-credentials-"));
    const path = join(root, "state.db");
    const store = new StateStore(path);
    replaceStateStoreForTests(store);
    const resolver = createCredentialResolver({ MULTIAGENTS_SLACK_WEBHOOK_URL: fixture });
    credentialStatusView(resolver, { audit: true });
    replaceStateStoreForTests();
    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from(fixture))).toBe(false);
    const schema = new StateStore(path);
    expect(JSON.stringify(schema.loadCredentialAuditEvents())).not.toContain(fixture);
    schema.close();
  });

  it("re-resolves configured status from the environment after restart", () => {
    expect(createCredentialResolver({}).status("slack_outbound").status).toBe("not_configured");
    expect(createCredentialResolver({ MULTIAGENTS_SLACK_WEBHOOK_URL: webhook }).status("slack_outbound").status).toBe("configured");
  });

  it("keeps a malformed Slack credential out of errors and logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const resolver = createCredentialResolver({ MULTIAGENTS_SLACK_WEBHOOK_URL: fixture });
    await expect(resolver.withCredential("github_cli", () => undefined)).rejects.toThrow("managed externally");
    expect(JSON.stringify({ error: "Slack test delivery failed" })).not.toContain(fixture);
    expect(JSON.stringify(log.mock.calls)).not.toContain(fixture);
    log.mockRestore();
  });

  it("keeps the Slack adapter independent of raw environment names", async () => {
    const source = await readFile(new URL("./slack-adapter.ts", import.meta.url), "utf8");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("MULTIAGENTS_SLACK_WEBHOOK_URL");
  });
});
