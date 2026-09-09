import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { aggregateRuntimeArtifactIdentity, executableContentIdentity, prepareImmutableExecutableBinding, prepareImmutableRuntimeBinding } from "./immutable-executable-binding";
import { cursorRuntimeManifestForTests } from "./provider-diagnostics";
import { buildSandboxCommand } from "./os-sandbox";

const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multiagents-immutable-codex-"));
  const source = join(root, "codex"); const replacement = join(root, "replacement");
  const put = async (path: string, label: string) => { await writeFile(path, `#!/bin/sh\nprintf '${label}\\n'\n`); await chmod(path, 0o700); };
  await put(source, "A");
  return { root, source, replacement, put };
}

describe("immutable Codex executable binding", () => {
  it("executes approved staged bytes after source metadata and alternate paths change", async () => {
    const value = await fixture();
    try {
      const approved = await executableContentIdentity(value.source);
      const staged = await prepareImmutableExecutableBinding(value.source, approved);
      await value.put(value.replacement, "B"); await rename(value.replacement, value.source);
      const command = buildSandboxCommand({
        profile: "agent_read_only",
        provider: "codex",
        cwd: value.root,
        command: { binary: "codex", args: [] },
        codexRuntime: {
          source: "optional", mainPackageRoot: value.root, installRoot: value.root, packageRoot: value.root,
          packageJson: join(value.root, "package.json"), nativeExecutable: value.source, optionalPackageName: "codex-linux-x64",
          nativeIdentity: approved, stagedExecutable: staged.path, stagedDigest: staged.digest,
        },
      });
      const result = await execute(command.binary, command.args, { cwd: command.cwd, env: command.env });
      expect(result.stdout.trim()).toBe("A");
      expect(command.args).toContain(staged.path);
      expect(command.args).not.toContain(value.source);
      await rm(value.source);
      expect((await execute(command.binary, command.args, { cwd: command.cwd, env: command.env })).stdout.trim()).toBe("A");
      await staged.cleanup();
      await expect(stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects same-size content replacement even when mtime is restored", async () => {
    const value = await fixture();
    try {
      const approved = await executableContentIdentity(value.source);
      const sourceStat = await stat(value.source);
      await value.put(value.source, "B"); await utimes(value.source, sourceStat.atime, sourceStat.mtime);
      await expect(prepareImmutableExecutableBinding(value.source, approved)).rejects.toThrow("changed");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects a symlink source and cleans a failed binding", async () => {
    const value = await fixture();
    try {
      const approved = await executableContentIdentity(value.source);
      await rm(value.source); await symlink("/bin/sh", value.source);
      await expect(prepareImmutableExecutableBinding(value.source, approved)).rejects.toThrow("non-symlink");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});

describe("immutable Cursor and Claude runtime bindings", () => {
  it.skipIf(process.env.MULTIAGENTS_LIVE_CURSOR_STAGING !== "1")("runs the installed Cursor version probe entirely from its staged runtime", async () => {
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
  }, 15_000);

  it("pins Cursor's wrapper, node, and index chain after source replacement and deletion", async () => {
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

  it("uses one canonical aggregate mode model and stages Cursor's complete numbered chunk closure", async () => {
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

  it("pins Claude's staged launcher through same-size mutation and source deletion", async () => {
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
