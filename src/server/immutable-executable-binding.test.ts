import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { probeBubblewrapNamespaceCapability, reportUnavailableBubblewrapNamespaceCapability } from "../../test/bubblewrap-namespace-capability";
import { aggregateRuntimeArtifactIdentity, executableContentIdentity, prepareImmutableExecutableBinding, prepareImmutableRuntimeBinding, runtimeBindingRootForTests, withRuntimeBindingRootForTests } from "./immutable-executable-binding";
import { cursorRuntimeManifestForTests } from "./provider-diagnostics";
import { buildSandboxCommand } from "./os-sandbox";

const execute = promisify(execFile);
const bubblewrapCapability = await probeBubblewrapNamespaceCapability();
reportUnavailableBubblewrapNamespaceCapability(bubblewrapCapability);
const realBubblewrapIt = bubblewrapCapability.available ? it : it.skip;

async function withBindingRoot<T>(run: (root: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), "multiagents-runtime-binding-"));
  try { return await withRuntimeBindingRootForTests(root, () => run(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multiagents-immutable-codex-"));
  const source = join(root, "codex"); const companion = join(root, "codex-code-mode-host"); const replacement = join(root, "replacement");
  const put = async (path: string, label: string) => { await writeFile(path, `#!/bin/sh\nprintf '${label}\\n'\n`); await chmod(path, 0o700); };
  await put(source, "A");
  await put(companion, "HOST");
  return { root, source, companion, replacement, put };
}

describe("immutable Codex executable binding", () => {
  it("uses the production default only outside a test binding-root scope", () => {
    expect(runtimeBindingRootForTests()).toBe(join(homedir(), ".multiagents", "runtime", "provider-bindings"));
  });

  it("isolates concurrent test binding-root scopes and restores the default", async () => {
    const [first, second] = await Promise.all([
      withBindingRoot(async (root) => runtimeBindingRootForTests() === root ? root : "wrong-root"),
      withBindingRoot(async (root) => runtimeBindingRootForTests() === root ? root : "wrong-root"),
    ]);
    expect(first).not.toBe(second);
    expect(runtimeBindingRootForTests()).toBe(join(homedir(), ".multiagents", "runtime", "provider-bindings"));
  });

  it("rejects binding-root overrides outside test mode", async () => {
    const environment = process.env as Record<string, string | undefined>;
    const previous = process.env.NODE_ENV;
    environment.NODE_ENV = "production";
    try { await expect(withRuntimeBindingRootForTests("/tmp/not-used", async () => undefined)).rejects.toThrow("test-only"); }
    finally {
      if (previous === undefined) delete environment.NODE_ENV;
      else environment.NODE_ENV = previous;
    }
  });

  it("surfaces filesystem errors from an injected binding root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "multiagents-runtime-binding-error-"));
    const root = join(parent, "not-a-directory");
    const value = await fixture();
    try {
      await writeFile(root, "not a directory");
      const identity = await executableContentIdentity(value.source);
      await expect(withRuntimeBindingRootForTests(root, () => prepareImmutableExecutableBinding(value.source, identity))).rejects.toThrow();
    } finally {
      await rm(value.root, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });

  realBubblewrapIt(bubblewrapCapability.available ? "executes approved staged bytes after source metadata and alternate paths change" : `executes approved staged bytes after source metadata and alternate paths change [host capability unavailable: ${bubblewrapCapability.reason}]`, async () => {
    await withBindingRoot(async (bindingRoot) => {
      const value = await fixture();
      try {
      const approved = await executableContentIdentity(value.source);
      const companionApproved = await executableContentIdentity(value.companion);
      const staged = await prepareImmutableRuntimeBinding([{ name: "codex", sourcePath: value.source, identity: approved }, { name: "codex-code-mode-host", sourcePath: value.companion, identity: companionApproved }]);
      await value.put(value.replacement, "B"); await rename(value.replacement, value.source);
      const command = buildSandboxCommand({
        profile: "agent_read_only",
        provider: "codex",
        cwd: value.root,
        command: { binary: "codex", args: [] },
        codexRuntime: {
          source: "optional", mainPackageRoot: value.root, installRoot: value.root, packageRoot: value.root,
          packageJson: join(value.root, "package.json"), nativeExecutable: value.source, nativeCompanionExecutable: value.companion, optionalPackageName: "codex-linux-x64",
          nativeIdentity: approved, nativeCompanionIdentity: companionApproved, aggregateDigest: staged.aggregateDigest,
          stagedRuntimeRoot: staged.directory, stagedExecutable: staged.paths.codex, stagedCompanionExecutable: staged.paths["codex-code-mode-host"], stagedDigest: staged.aggregateDigest,
        },
      });
      const result = await execute(command.binary, command.args, { cwd: command.cwd, env: command.env });
      expect(result.stdout.trim()).toBe("A");
      expect(staged.directory.startsWith(`${bindingRoot}/`)).toBe(true);
      expect(command.args).toContain(staged.directory);
      expect(command.args).not.toContain(value.source);
      await rm(value.source);
      expect((await execute(command.binary, command.args, { cwd: command.cwd, env: command.env })).stdout.trim()).toBe("A");
      await staged.cleanup();
      await expect(stat(staged.paths.codex)).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await rm(value.root, { recursive: true, force: true }); }
    });
  });

  it("rejects same-size content replacement even when mtime is restored", async () => {
    await withBindingRoot(async () => {
      const value = await fixture();
      try {
      const approved = await executableContentIdentity(value.source);
      const sourceStat = await stat(value.source);
      await value.put(value.source, "B"); await utimes(value.source, sourceStat.atime, sourceStat.mtime);
      await expect(prepareImmutableExecutableBinding(value.source, approved)).rejects.toThrow("changed");
      const companionApproved = await executableContentIdentity(value.companion);
      const companionStat = await stat(value.companion);
      await value.put(value.companion, "GOST"); await utimes(value.companion, companionStat.atime, companionStat.mtime);
      await expect(prepareImmutableRuntimeBinding([{ name: "codex-code-mode-host", sourcePath: value.companion, identity: companionApproved }])).rejects.toThrow("changed");
      } finally { await rm(value.root, { recursive: true, force: true }); }
    });
  });

  it("rejects a symlink source and cleans a failed binding", async () => {
    await withBindingRoot(async () => {
      const value = await fixture();
      try {
      const approved = await executableContentIdentity(value.source);
      await rm(value.source); await symlink("/bin/sh", value.source);
      await expect(prepareImmutableExecutableBinding(value.source, approved)).rejects.toThrow("non-symlink");
      await chmod(value.companion, 0o600);
      await expect(executableContentIdentity(value.companion)).rejects.toThrow("regular required file");
      } finally { await rm(value.root, { recursive: true, force: true }); }
    });
  });

  realBubblewrapIt(bubblewrapCapability.available ? "stages both Codex executables into one read-only outer sandbox directory" : `stages both Codex executables into one read-only outer sandbox directory [host capability unavailable: ${bubblewrapCapability.reason}]`, async () => {
    await withBindingRoot(async () => {
      const value = await fixture();
      try {
      const staged = await prepareImmutableRuntimeBinding([
        { name: "codex", sourcePath: value.source, identity: await executableContentIdentity(value.source) },
        { name: "codex-code-mode-host", sourcePath: value.companion, identity: await executableContentIdentity(value.companion) },
      ]);
      const command = buildSandboxCommand({ profile: "agent_read_only", provider: "codex", cwd: value.root, command: { binary: "codex", args: [] }, codexRuntime: {
        source: "vendor", mainPackageRoot: value.root, installRoot: value.root, packageRoot: value.root, packageJson: join(value.root, "package.json"), optionalPackageName: "codex-linux-x64",
        nativeExecutable: value.source, nativeCompanionExecutable: value.companion, nativeIdentity: await executableContentIdentity(value.source), nativeCompanionIdentity: await executableContentIdentity(value.companion), aggregateDigest: staged.aggregateDigest,
        stagedRuntimeRoot: staged.directory, stagedExecutable: staged.paths.codex, stagedCompanionExecutable: staged.paths["codex-code-mode-host"], stagedDigest: staged.aggregateDigest,
      } });
      const args = [...command.args]; const separator = args.lastIndexOf("--"); args.splice(separator + 1, args.length, "/bin/sh", "-c", "test -x /opt/multiagents/codex/codex && test -x /opt/multiagents/codex/codex-code-mode-host && test ! -w /opt/multiagents/codex/codex-code-mode-host && printf HOST_OK");
      expect((await execute(command.binary, args, { cwd: command.cwd, env: command.env })).stdout.trim()).toBe("HOST_OK");
      await staged.cleanup();
      } finally { await rm(value.root, { recursive: true, force: true }); }
    });
  });
});

describe("immutable Cursor and Claude runtime bindings", () => {
  (bubblewrapCapability.available ? it.skipIf(process.env.MULTIAGENTS_LIVE_CURSOR_STAGING !== "1") : it.skip)(bubblewrapCapability.available ? "runs the installed Cursor version probe entirely from its staged runtime" : `runs the installed Cursor version probe entirely from its staged runtime [host capability unavailable: ${bubblewrapCapability.reason}]`, async () => {
    await withBindingRoot(async () => {
      const launcher = join(homedir(), ".local", "bin", "agent");
      const runtimeRoot = dirname(await realpath(launcher));
      const manifest = await cursorRuntimeManifestForTests(runtimeRoot);
      const staged = await prepareImmutableRuntimeBinding(manifest.artifacts.map((artifact) => ({ ...artifact, sourcePath: join(runtimeRoot, artifact.name) })));
      try {
      const command = buildSandboxCommand({ profile: "agent_read_only", provider: "cursor", cwd: process.cwd(), command: { binary: "agent", args: ["--version"] }, pseudoTty: true, cursorRuntime: { stagedRuntimeRoot: staged.directory, aggregateDigest: staged.aggregateDigest } });
      const result = await execute(command.binary, command.args, { cwd: command.cwd, env: command.env }).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(`staged Cursor probe failed: ${error.stdout ?? ""}\n${error.stderr ?? ""}`);
      });
      expect(result.stdout).toContain("2026.09.02-c22c1a3");
      expect(command.args).toContain(staged.directory);
      expect(command.args).not.toContain(runtimeRoot);
      } finally { await staged.cleanup(); }
    });
  }, 15_000);

  realBubblewrapIt(bubblewrapCapability.available ? "pins Cursor's wrapper, node, and index chain after source replacement and deletion" : `pins Cursor's wrapper, node, and index chain after source replacement and deletion [host capability unavailable: ${bubblewrapCapability.reason}]`, async () => {
    await withBindingRoot(async () => {
      const root = await mkdtemp(join(tmpdir(), "multiagents-immutable-cursor-"));
      const put = async (name: string, content: string, mode: number) => { const path = join(root, name); await writeFile(path, content); await chmod(path, mode); return path; };
      try {
      const wrapper = await put("cursor-agent", "#!/bin/sh\nexec \"$(dirname \"$0\")/node\" \"$(dirname \"$0\")/index.js\" \"$@\"\n", 0o700);
      const node = await put("node", "#!/bin/sh\nexec /bin/sh \"$1\"\n", 0o700);
      const index = await put("index.js", "printf 'A\\n'\n", 0o600);
      const identities = await Promise.all([executableContentIdentity(wrapper), executableContentIdentity(node), executableContentIdentity(index, false)]);
      const staged = await prepareImmutableRuntimeBinding([{ name: "cursor-agent", sourcePath: wrapper, identity: identities[0] }, { name: "node", sourcePath: node, identity: identities[1] }, { name: "index.js", sourcePath: index, identity: identities[2], executable: false }]);
      await writeFile(index, "printf 'B\\n'\n"); await rm(wrapper); await rm(node); await rm(index);
      const command = buildSandboxCommand({ profile: "agent_read_only", provider: "cursor", cwd: root, command: { binary: "agent", args: [] }, cursorRuntime: { stagedRuntimeRoot: staged.directory, aggregateDigest: staged.aggregateDigest } });
      expect((await execute(command.binary, command.args, { cwd: command.cwd, env: command.env })).stdout.trim()).toBe("A");
      for (const source of [wrapper, node, index]) expect(command.args).not.toContain(source);
      await staged.cleanup();
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  realBubblewrapIt(bubblewrapCapability.available ? "uses one canonical aggregate mode model and stages Cursor's complete numbered chunk closure" : `uses one canonical aggregate mode model and stages Cursor's complete numbered chunk closure [host capability unavailable: ${bubblewrapCapability.reason}]`, async () => {
    await withBindingRoot(async () => {
      const root = await mkdtemp(join(tmpdir(), "multiagents-cursor-manifest-"));
      const put = async (name: string, content: string, mode: number) => { const path = join(root, name); await writeFile(path, content); await chmod(path, mode); return path; };
      try {
      await put("cursor-agent", "#!/bin/sh\nexec \"$(dirname \"$0\")/node\" \"$(dirname \"$0\")/index.js\" \"$@\"\n", 0o755);
      await put("node", "#!/bin/sh\nexec /bin/sh \"$1\"\n", 0o755);
      await put("index.js", "# __webpack_require__.u=e=>e+'.index.js'; require('./'+__webpack_require__.u(t)); cursorsandbox getRipgrepBinaryPath\ntest -f \"$(dirname \"$0\")/2.index.js\" || exit 91\nprintf 'A\\n'\n", 0o644);
      await put("cursorsandbox", "#!/bin/sh\nexit 0\n", 0o755);
      await put("rg", "#!/bin/sh\nexit 0\n", 0o755);
      await put("10.index.js", "# chunk 10\n", 0o644); await put("2.index.js", "# chunk 2\n", 0o644);
      await mkdir(join(root, "node_modules", "tree-sitter"), { recursive: true });
      await writeFile(join(root, "node_modules", "tree-sitter", "index.js"), "module.exports = {};\n");
      await chmod(join(root, "node_modules", "tree-sitter", "index.js"), 0o644);
      await put("merkle-tree-napi.linux-x64-gnu.node", "native-addon", 0o755);
      await put("unrelated.js", "not a runtime chunk\n", 0o644);
      const manifest = await cursorRuntimeManifestForTests(root);
      expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual(["cursor-agent", "node", "index.js", "cursorsandbox", "rg", "10.index.js", "2.index.js", "merkle-tree-napi.linux-x64-gnu.node", "node_modules/tree-sitter/index.js"]);
      await writeFile(join(root, "unrelated.js"), "changed but not in the runtime closure\n");
      expect((await cursorRuntimeManifestForTests(root)).aggregateDigest).toBe(manifest.aggregateDigest);
      const staged = await prepareImmutableRuntimeBinding(manifest.artifacts.map((artifact) => ({ ...artifact, sourcePath: join(root, artifact.name) })));
      expect(staged.aggregateDigest).toBe(manifest.aggregateDigest);
      expect(staged.aggregateDigest).toBe(aggregateRuntimeArtifactIdentity(manifest.artifacts));
      expect(Object.keys(staged.paths).sort()).toEqual(["10.index.js", "2.index.js", "cursor-agent", "cursorsandbox", "index.js", "merkle-tree-napi.linux-x64-gnu.node", "node", "node_modules/tree-sitter/index.js", "rg"]);
      expect((await stat(join(staged.directory, "node_modules", "tree-sitter", "index.js"))).mode & 0o777).toBe(0o400);
      const command = buildSandboxCommand({ profile: "agent_read_only", provider: "cursor", cwd: root, command: { binary: "agent", args: [] }, cursorRuntime: { stagedRuntimeRoot: staged.directory, aggregateDigest: staged.aggregateDigest } });
      expect((await execute(command.binary, command.args, { cwd: command.cwd, env: command.env })).stdout.trim()).toBe("A");
      expect(command.args).toContain(staged.directory);
      for (const artifact of manifest.artifacts) expect(command.args).not.toContain(join(root, artifact.name));
      await writeFile(join(root, "2.index.js"), "# changed chunk\n");
      expect((await cursorRuntimeManifestForTests(root)).aggregateDigest).not.toBe(manifest.aggregateDigest);
      await writeFile(join(root, "node_modules", "tree-sitter", "index.js"), "module.exports = { changed: true };\n");
      expect((await cursorRuntimeManifestForTests(root)).aggregateDigest).not.toBe(manifest.aggregateDigest);
      await staged.cleanup();
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  it("rejects a missing or symlinked required Cursor runtime chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "multiagents-cursor-chunk-reject-"));
    try {
      await Promise.all([
        writeFile(join(root, "cursor-agent"), "wrapper"), writeFile(join(root, "node"), "node"),
        writeFile(join(root, "index.js"), "__webpack_require__.u=e=>e+'.index.js'; require('./'+__webpack_require__.u(t));"),
      ]);
      await Promise.all([chmod(join(root, "cursor-agent"), 0o755), chmod(join(root, "node"), 0o755), chmod(join(root, "index.js"), 0o644)]);
      await expect(cursorRuntimeManifestForTests(root)).rejects.toThrow("unsupported chunk layout");
      await writeFile(join(root, "1.index.js"), "chunk"); await symlink("/bin/sh", join(root, "2.index.js"));
      await expect(cursorRuntimeManifestForTests(root)).rejects.toThrow("non-symlink");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  realBubblewrapIt(bubblewrapCapability.available ? "pins Claude's staged launcher through same-size mutation and source deletion" : `pins Claude's staged launcher through same-size mutation and source deletion [host capability unavailable: ${bubblewrapCapability.reason}]`, async () => {
    await withBindingRoot(async () => {
      const value = await fixture();
      try {
      const approved = await executableContentIdentity(value.source);
      const staged = await prepareImmutableExecutableBinding(value.source, approved);
      const sourceStat = await stat(value.source); await value.put(value.source, "B"); await utimes(value.source, sourceStat.atime, sourceStat.mtime);
      await expect(prepareImmutableExecutableBinding(value.source, approved)).rejects.toThrow("changed");
      await rm(value.source);
      const command = buildSandboxCommand({ profile: "agent_read_only", provider: "claude", cwd: value.root, command: { binary: join(homedir(), ".local", "bin", "claude"), args: [] }, claudeRuntime: { stagedExecutable: staged.path, digest: staged.digest } });
      expect((await execute(command.binary, command.args, { cwd: command.cwd, env: command.env })).stdout.trim()).toBe("A");
      expect(command.args).toContain(staged.path);
      await staged.cleanup();
      } finally { await rm(value.root, { recursive: true, force: true }); }
    });
  });
});
