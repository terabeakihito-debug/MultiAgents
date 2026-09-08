import { describe, expect, it } from "vitest";
import { classifyProviderVersion, parseProviderVersion } from "../providers/compatibility";
import { diagnoseProvider, providerDiagnostics } from "./provider-diagnostics";
import { StateStore } from "./state-store";

describe("provider compatibility", () => {
  it("strictly parses the three fixed version formats and rejects malformed values", () => {
    expect(parseProviderVersion("codex", "codex-cli 0.153.4")?.normalized).toBe("0.153.4");
    expect(parseProviderVersion("cursor", "2026.09.02-c22c1a3")?.normalized).toBe("2026.9.2");
    expect(parseProviderVersion("claude", "2.1.260 (Claude Code)")?.normalized).toBe("2.1.260");
    expect(parseProviderVersion("codex", "updated codex-cli 0.153.4")).toBeUndefined();
    expect(parseProviderVersion("claude", "2.1.260")).toBeUndefined();
  });

  it("accepts a complete Cursor version line on stderr or a pseudo-TTY ANSI stream", () => {
    expect(parseProviderVersion("cursor", "\u001b[?25l2026.09.02-c22c1a3\r\n\u001b[?25h")?.normalized).toBe("2026.9.2");
    expect(parseProviderVersion("cursor", "launcher warning\n2026.09.02-c22c1a3\n")?.normalized).toBe("2026.9.2");
  });

  it("classifies known, warning, and unsupported versions safely", () => {
    expect(classifyProviderVersion("codex", parseProviderVersion("codex", "codex-cli 0.153.4")!)).toBe("supported");
    expect(classifyProviderVersion("codex", parseProviderVersion("codex", "codex-cli 0.154.0")!)).toBe("supported_with_warning");
    expect(classifyProviderVersion("codex", parseProviderVersion("codex", "codex-cli 0.200.0")!)).toBe("unsupported_version");
  });

  it("blocks a missing required flag without a prompt fallback", async () => {
    const execute = async (args: string[]) => args[0] === "--version" ? { code: 0, stdout: "codex-cli 0.153.4", stderr: "" } : { code: 0, stdout: "--sandbox --cd", stderr: "" };
    await expect(diagnoseProvider("codex", { executableAvailable: true, credentialAvailable: true, execute, persist: false })).resolves.toMatchObject({ status: "flag_incompatible", flagsCompatible: false });
  });

  it("classifies empty Cursor metadata output as a blocked version probe failure", async () => {
    await expect(diagnoseProvider("cursor", { executableAvailable: true, credentialAvailable: true, execute: async () => ({ code: 0, stdout: "", stderr: "" }), persist: false })).resolves.toMatchObject({ status: "version_probe_failed", flagsCompatible: false, launchCompatible: false });
  });

  it("accepts the current Cursor version and its actual launcher flags", async () => {
    const execute = async (args: string[]) => args[0] === "--version"
      ? { code: 0, stdout: "\u001b[?25l2026.09.02-c22c1a3\r\n\u001b[?25h", stderr: "" }
      : { code: 0, stdout: "--mode --sandbox --workspace --skip-worktree-setup -p", stderr: "" };
    await expect(diagnoseProvider("cursor", { executableAvailable: true, credentialAvailable: true, execute, persist: false })).resolves.toMatchObject({ status: "supported", version: "2026.9.2", flagsCompatible: true });
  });

  it("keeps only twenty secret-free snapshots and stores acknowledgement separately", () => {
    const store = new StateStore(":memory:");
    for (let index = 0; index < 22; index += 1) store.saveProviderCompatibility({ provider: "codex", version: "0.153.4", status: "supported", flagsCompatible: true, credentialStatus: "available", sandboxCompatible: true, launchCompatible: true, checkedAt: new Date(index).toISOString(), versionChanged: false, identityChanged: false });
    expect(store.loadProviderCompatibilityHistory("codex")).toHaveLength(20);
    store.acknowledgeProviderCompatibility("codex", "0.153.4");
    expect(store.loadProviderCompatibilityAcknowledgement("codex")).toBe("0.153.4");
    store.close();
  });

  it.runIf(process.env.MULTIAGENTS_REAL_PROVIDER_CHECK === "1")("runs local-only diagnostics without provider requests", async () => {
    const diagnostics = await providerDiagnostics({ force: true });
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((item) => item.credentialStatus !== undefined && item.checkedAt)).toBe(true);
    expect(diagnostics.map((item) => item.provider)).toEqual(["codex", "cursor", "claude"]);
    expect(diagnostics.every((item) => item.status === "supported" && item.credentialStatus === "available" && item.sandboxCompatible)).toBe(true);
  });
});
