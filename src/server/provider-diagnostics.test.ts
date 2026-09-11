import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProviderVersion, parseProviderVersion } from "../providers/compatibility";
import { assertProviderExecutionIdentity, diagnoseProvider, prepareCodexImmutableBinding, providerDiagnostics, providerExecutionIdentityForTests, PROVIDER_COMPATIBILITY_POLICY_VERSION, ProviderDiagnosticTimeoutError, readCodexRuntimeResolverOutputForTests, resolveCodexRuntimeFresh } from "./provider-diagnostics";
import { StateStore } from "./state-store";
import { buildSandboxCommand } from "./os-sandbox";

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

  it("binds Codex and Cursor identities to the mounted runtime payload rather than convenience paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-provider-identity-"));
    const home = join(root, "home"); const nodeRoot = join(root, "node"); const nodePath = join(nodeRoot, "bin", "node");
    const codex = join(nodeRoot, "lib", "node_modules", "@openai", "codex"); const cursorInstall = join(root, "cursor-install"); const triple = "x86_64-unknown-linux-musl";
    try {
      await mkdir(join(home, ".codex"), { recursive: true }); await mkdir(join(home, ".config", "cursor"), { recursive: true }); await mkdir(join(home, ".local", "bin"), { recursive: true });
      await mkdir(join(codex, "bin"), { recursive: true }); await mkdir(join(codex, "vendor", triple, "bin"), { recursive: true }); await mkdir(join(nodeRoot, "bin"), { recursive: true }); await mkdir(cursorInstall, { recursive: true });
      await Promise.all([writeFile(nodePath, "node"), writeFile(join(codex, "bin", "codex.js"), "entry"), writeFile(join(codex, "package.json"), "{\"name\":\"codex\"}"), writeFile(join(codex, "vendor", triple, "bin", "codex"), "one"), writeFile(join(codex, "vendor", triple, "bin", "codex-code-mode-host"), "host-one"), writeFile(join(home, ".codex", "auth.json"), "metadata"), writeFile(join(home, ".config", "cursor", "auth.json"), "metadata"), writeFile(join(cursorInstall, "cursor-agent"), "one"), writeFile(join(cursorInstall, "node"), "one"), writeFile(join(cursorInstall, "index.js"), "one")]);
      await Promise.all([chmod(nodePath, 0o700), chmod(join(codex, "bin", "codex.js"), 0o700), chmod(join(codex, "vendor", triple, "bin", "codex"), 0o700), chmod(join(codex, "vendor", triple, "bin", "codex-code-mode-host"), 0o700), chmod(join(cursorInstall, "cursor-agent"), 0o700), chmod(join(cursorInstall, "node"), 0o700), chmod(join(home, ".codex", "auth.json"), 0o600), chmod(join(home, ".config", "cursor", "auth.json"), 0o600)]);
      await symlink(join(cursorInstall, "launcher"), join(home, ".local", "bin", "agent")); await writeFile(join(cursorInstall, "launcher"), "launcher"); await chmod(join(cursorInstall, "launcher"), 0o700);
      const context = { home, nodePath, nodeRoot };
      const codexBefore = await providerExecutionIdentityForTests("codex", context); const cursorBefore = await providerExecutionIdentityForTests("cursor", context);
      await rm(join(codex, "vendor", triple, "bin", "codex-code-mode-host"));
      await expect(providerExecutionIdentityForTests("codex", context)).rejects.toThrow();
      await expect(assertProviderExecutionIdentity("codex", { provider: "codex", status: "supported", flagsCompatible: true, credentialStatus: "available", sandboxCompatible: true, launchCompatible: true, checkedAt: new Date().toISOString(), versionChanged: false, identityChanged: false, identity: codexBefore }, context)).rejects.toThrow();
      await writeFile(join(codex, "vendor", triple, "bin", "codex-code-mode-host"), "host-one"); await chmod(join(codex, "vendor", triple, "bin", "codex-code-mode-host"), 0o700);
      await writeFile(join(codex, "vendor", triple, "bin", "codex"), "two"); await writeFile(join(cursorInstall, "cursor-agent"), "two");
      expect(await providerExecutionIdentityForTests("codex", context)).not.toBe(codexBefore);
      expect(await providerExecutionIdentityForTests("cursor", context)).not.toBe(cursorBefore);
      const cursorAfterWrapper = await providerExecutionIdentityForTests("cursor", context);
      await writeFile(join(cursorInstall, "node"), "two"); expect(await providerExecutionIdentityForTests("cursor", context)).not.toBe(cursorAfterWrapper);
      const cursorAfterNode = await providerExecutionIdentityForTests("cursor", context);
      await writeFile(join(cursorInstall, "index.js"), "two"); expect(await providerExecutionIdentityForTests("cursor", context)).not.toBe(cursorAfterNode);
      await writeFile(join(cursorInstall, "index.js"), "__webpack_require__.u=e=>e+'.index.js'; require('./'+__webpack_require__.u(t));"); await writeFile(join(cursorInstall, "1.index.js"), "chunk-one"); await writeFile(join(cursorInstall, "2.index.js"), "chunk-two");
      const cursorWithChunks = await providerExecutionIdentityForTests("cursor", context);
      await writeFile(join(cursorInstall, "2.index.js"), "changed-two"); expect(await providerExecutionIdentityForTests("cursor", context)).not.toBe(cursorWithChunks);
      const cursorChangedChunk = await providerExecutionIdentityForTests("cursor", context);
      await writeFile(join(cursorInstall, "unrelated.txt"), "outside runtime closure"); expect(await providerExecutionIdentityForTests("cursor", context)).toBe(cursorChangedChunk);
      const fallbackIdentity = await providerExecutionIdentityForTests("codex", context); const sibling = join(nodeRoot, "lib", "node_modules", "@openai", "codex-linux-x64"); const nested = join(codex, "node_modules", "@openai", "codex-linux-x64");
      for (const optional of [sibling, nested]) {
        await mkdir(join(optional, "vendor", triple, "bin"), { recursive: true });
        await Promise.all([writeFile(join(optional, "package.json"), "{\"name\":\"optional\"}"), writeFile(join(optional, "vendor", triple, "bin", "codex"), optional === nested ? "nested" : "sibling"), writeFile(join(optional, "vendor", triple, "bin", "codex-code-mode-host"), optional === nested ? "nested-host" : "sibling-host")]);
        await Promise.all([chmod(join(optional, "vendor", triple, "bin", "codex"), 0o700), chmod(join(optional, "vendor", triple, "bin", "codex-code-mode-host"), 0o700)]);
      }
      expect((await resolveCodexRuntimeFresh(nodeRoot)).nativeExecutable).toBe(join(nested, "vendor", triple, "bin", "codex"));
      const nestedIdentity = await providerExecutionIdentityForTests("codex", context); expect(nestedIdentity).not.toBe(fallbackIdentity);
      await writeFile(join(sibling, "vendor", triple, "bin", "codex"), "sibling-two"); expect(await providerExecutionIdentityForTests("codex", context)).toBe(nestedIdentity);
      await writeFile(join(nested, "vendor", triple, "bin", "codex"), "nested-two"); expect(await providerExecutionIdentityForTests("codex", context)).not.toBe(nestedIdentity);
      await rm(nested, { recursive: true, force: true }); expect((await resolveCodexRuntimeFresh(nodeRoot)).nativeExecutable).toBe(join(sibling, "vendor", triple, "bin", "codex"));
      const siblingIdentity = await providerExecutionIdentityForTests("codex", context); await rm(sibling, { recursive: true, force: true }); expect((await resolveCodexRuntimeFresh(nodeRoot)).source).toBe("vendor"); expect(await providerExecutionIdentityForTests("codex", context)).not.toBe(siblingIdentity);
      expect(PROVIDER_COMPATIBILITY_POLICY_VERSION).toMatch(/^[a-f0-9]{24}$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("observes fresh package exports resolution and binds the selected runtime through launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-fresh-codex-"));
    const home = join(root, "home"); const nodeRoot = join(root, "node"); const nodePath = join(nodeRoot, "bin", "node"); const codex = join(nodeRoot, "lib", "node_modules", "@openai", "codex"); const optional = join(codex, "node_modules", "@openai", "codex-linux-x64"); const triple = "x86_64-unknown-linux-musl";
    const runtime = (name: string) => join(optional, name); const native = (name: string) => join(runtime(name), "vendor", triple, "bin", "codex"); const companion = (name: string) => join(runtime(name), "vendor", triple, "bin", "codex-code-mode-host");
    try {
      await Promise.all([mkdir(join(home, ".codex"), { recursive: true }), mkdir(join(codex, "bin"), { recursive: true }), mkdir(join(codex, "vendor", triple, "bin"), { recursive: true }), mkdir(join(nodeRoot, "bin"), { recursive: true }), mkdir(join(runtime("a"), "vendor", triple, "bin"), { recursive: true }), mkdir(join(runtime("b"), "vendor", triple, "bin"), { recursive: true })]);
      await Promise.all([writeFile(nodePath, "node"), writeFile(join(home, ".codex", "auth.json"), "metadata"), writeFile(join(codex, "bin", "codex.js"), "entry"), writeFile(join(codex, "package.json"), "{}"), writeFile(join(codex, "vendor", triple, "bin", "codex"), "vendor"), writeFile(join(codex, "vendor", triple, "bin", "codex-code-mode-host"), "vendor-host"), writeFile(join(runtime("a"), "package.json"), "{}"), writeFile(join(runtime("b"), "package.json"), "{}"), writeFile(native("a"), "runtime-a"), writeFile(native("b"), "runtime-b"), writeFile(companion("a"), "host-a"), writeFile(companion("b"), "host-b")]);
      await Promise.all([chmod(nodePath, 0o700), chmod(join(home, ".codex", "auth.json"), 0o600), chmod(join(codex, "bin", "codex.js"), 0o700), chmod(join(codex, "vendor", triple, "bin", "codex"), 0o700), chmod(join(codex, "vendor", triple, "bin", "codex-code-mode-host"), 0o700), chmod(native("a"), 0o700), chmod(native("b"), 0o700), chmod(companion("a"), 0o700), chmod(companion("b"), 0o700)]);
      const context = { home, nodePath, nodeRoot };
      await writeFile(join(optional, "package.json"), JSON.stringify({ exports: { "./package.json": "./a/package.json" } }));
      const selectedA = await resolveCodexRuntimeFresh(nodeRoot); const identityA = await providerExecutionIdentityForTests("codex", context);
      expect(selectedA.nativeExecutable).toBe(native("a"));
      await writeFile(join(optional, "package.json"), JSON.stringify({ exports: { "./package.json": "./b/package.json" } }));
      const selectedB = await resolveCodexRuntimeFresh(nodeRoot); const identityB = await providerExecutionIdentityForTests("codex", context);
      expect(selectedB.nativeExecutable).toBe(native("b")); expect(identityB).not.toBe(identityA);
      await expect(assertProviderExecutionIdentity("codex", { provider: "codex", status: "supported", flagsCompatible: true, credentialStatus: "available", sandboxCompatible: true, launchCompatible: true, checkedAt: new Date().toISOString(), versionChanged: false, identityChanged: false, identity: identityA }, context)).rejects.toThrow("not compatible");
      const binding = await assertProviderExecutionIdentity("codex", { provider: "codex", status: "supported", flagsCompatible: true, credentialStatus: "available", sandboxCompatible: true, launchCompatible: true, checkedAt: new Date().toISOString(), versionChanged: false, identityChanged: false, identity: identityB }, context);
      expect(binding.codexRuntime?.nativeExecutable).toBe(native("b"));
      const immutable = await prepareCodexImmutableBinding(binding.codexRuntime!);
      const pinnedCommand = buildSandboxCommand({ profile: "agent_read_only", provider: "codex", cwd: root, codexRuntime: immutable.binding, command: { binary: "codex", args: ["--version"] } });
      const pinnedArgs = pinnedCommand.args.join("\0");
      expect(pinnedArgs).toContain(`${immutable.binding.stagedRuntimeRoot}\0/opt/multiagents/codex`);
      expect(immutable.binding.stagedExecutable).toBe(join(immutable.binding.stagedRuntimeRoot, "codex"));
      expect(immutable.binding.stagedCompanionExecutable).toBe(join(immutable.binding.stagedRuntimeRoot, "codex-code-mode-host"));
      expect(pinnedArgs).not.toContain(`${codex}\0/opt/multiagents/codex`);
      await immutable.cleanup();
      await writeFile(native("a"), "unselected-runtime-changed"); expect(await providerExecutionIdentityForTests("codex", context)).toBe(identityB);
      await writeFile(companion("b"), "selected-host-changed"); expect(await providerExecutionIdentityForTests("codex", context)).not.toBe(identityB);
      await writeFile(native("b"), "selected-runtime-changed"); expect(await providerExecutionIdentityForTests("codex", context)).not.toBe(identityB);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed for malformed, unsafe, timed-out, and flooded resolver results", async () => {
    const result = (overrides: Partial<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean }> = {}) => ({ code: 0, stdout: "{}", stderr: "", timedOut: false, stdoutTruncated: false, stderrTruncated: false, ...overrides });
    await expect(resolveCodexRuntimeFresh(undefined, { execute: async () => result() })).rejects.toThrow("schema");
    await expect(resolveCodexRuntimeFresh(undefined, { execute: async () => result({ stdout: JSON.stringify({ source: "vendor", mainPackageRoot: "/etc", installRoot: "/etc", packageRoot: "/etc", packageJson: "/etc/passwd", nativeExecutable: "/bin/sh", optionalPackageName: "codex-linux-x64" }) }) })).rejects.toThrow();
    await expect(resolveCodexRuntimeFresh(undefined, { execute: async () => result({ timedOut: true }) })).rejects.toBeInstanceOf(ProviderDiagnosticTimeoutError);
    await expect(resolveCodexRuntimeFresh(undefined, { execute: async () => result({ stdoutTruncated: true, stdout: "x".repeat(200_000) }) })).rejects.toThrow("failed");
  });

  it("rejects oversized resolver file output without reading it unboundedly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiagents-oversized-resolver-output-"));
    const output = join(directory, "resolution.json");
    try {
      await writeFile(output, "x".repeat(64 * 1024 + 1));
      await expect(readCodexRuntimeResolverOutputForTests(output)).rejects.toThrow("Codex runtime resolution failed");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.runIf(process.env.MULTIAGENTS_REAL_PROVIDER_CHECK === "1")("runs local-only diagnostics without provider requests", async () => {
    const diagnostics = await providerDiagnostics({ force: true });
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((item) => item.credentialStatus !== undefined && item.checkedAt)).toBe(true);
    expect(diagnostics.map((item) => item.provider)).toEqual(["codex", "cursor", "claude"]);
    expect(diagnostics.every((item) => item.status === "supported" && item.credentialStatus === "available" && item.sandboxCompatible)).toBe(true);
  });
});
