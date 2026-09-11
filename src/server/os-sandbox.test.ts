import { spawn } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BWRAP_BINARY,
  OsSandboxUnavailableError,
  SANDBOX_HOME,
  SANDBOX_PATH,
  buildSandboxCommand,
  checkOsSandboxAvailability,
  publicOsSandboxPolicy,
} from "./os-sandbox";
import { runValidationCommand } from "./pull-request";
import type { RepoTask } from "./tasks";

const TEST_NODE_ROOT = dirname(dirname(process.execPath));
const TEST_CODEX_ROOT = join(TEST_NODE_ROOT, "lib", "node_modules", "@openai", "codex");
const CODEX_RUNTIME_FIXTURE = {
  source: "vendor" as const,
  mainPackageRoot: TEST_CODEX_ROOT,
  installRoot: TEST_CODEX_ROOT,
  packageRoot: TEST_CODEX_ROOT,
  packageJson: join(TEST_CODEX_ROOT, "package.json"),
  nativeExecutable: process.execPath,
  nativeCompanionExecutable: process.execPath,
  optionalPackageName: "codex-linux-x64",
  nativeIdentity: { digest: "fixture", dev: 0, ino: 0, size: 0, ctimeMs: 0, mode: 0o500, uid: 0, gid: 0 },
  nativeCompanionIdentity: { digest: "fixture-companion", dev: 0, ino: 0, size: 0, ctimeMs: 0, mode: 0o500, uid: 0, gid: 0 },
  aggregateDigest: "fixture-aggregate",
  stagedRuntimeRoot: dirname(process.execPath),
  stagedExecutable: process.execPath,
  stagedCompanionExecutable: process.execPath,
  stagedDigest: "fixture-aggregate",
};
const CURSOR_RUNTIME_FIXTURE = { stagedRuntimeRoot: dirname(process.execPath), aggregateDigest: "fixture" };
const CLAUDE_RUNTIME_FIXTURE = { stagedExecutable: process.execPath, digest: "fixture" };

function shellCommand(command: ReturnType<typeof buildSandboxCommand>, script: string) {
  const args = [...command.args];
  const separator = args.lastIndexOf("--");
  args.splice(separator + 1, args.length, "/bin/sh", "-c", script);
  return { ...command, args };
}

function run(command: ReturnType<typeof buildSandboxCommand>, timeoutMs = 10_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command.binary, command.args, { cwd: command.cwd, env: command.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout += value; });
    child.stderr.on("data", (value: string) => { stderr += value; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("sandbox test timed out")); }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe("Phase 18 OS sandbox command policy", () => {
  it("runs Cursor metadata pseudo-TTY probes inside the provider PID namespace", () => {
    const command = buildSandboxCommand({ profile: "agent_read_only", provider: "cursor", cwd: "/tmp/task-worktree", command: { binary: "agent", args: ["--version"] }, pseudoTty: true, cursorRuntime: CURSOR_RUNTIME_FIXTURE });
    expect(command.binary).toBe(BWRAP_BINARY);
    expect(command.args).toContain("--unshare-pid");
    expect(command.args).toContain("--die-with-parent");
    expect(command.args).toContain("--unshare-net");
    expect(command.args.slice(-5)).toEqual(["--", "/usr/bin/script", "-qefc", "'/opt/multiagents/cursor/cursor-agent' '--version'", "/dev/null"]);
  });
  it("pins bubblewrap absolutely and fixes namespace, environment, mount, and validation network arguments", () => {
    const command = buildSandboxCommand({ profile: "validation", cwd: "/tmp/task-worktree", command: { binary: "/bin/sh", args: ["-c", "true"] } });
    expect(command.binary).toBe("/usr/bin/bwrap");
    expect(command.args).toEqual(expect.arrayContaining(["--unshare-user", "--unshare-pid", "--unshare-net", "--clearenv", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", "/tmp/task-worktree", "/project"]));
    expect(command.args).not.toContain("/mnt/c");
    expect(command.args).not.toContain("/mnt/d");
    expect(command.args.join("\0")).not.toContain("WSL_INTEROP");
    expect(command.args).toEqual(expect.arrayContaining(["--setenv", "HOME", SANDBOX_HOME, "--setenv", "PATH", SANDBOX_PATH]));
  });

  it("constructs implement and review profiles with only the task worktree writable", () => {
    const implement = buildSandboxCommand({ profile: "agent_implement", cwd: "/tmp/task", writableRoot: "/tmp/task", baseRepoRoot: "/tmp/base", provider: "codex", codexRuntime: CODEX_RUNTIME_FIXTURE, command: { binary: "codex", args: ["--version"] } });
    const review = buildSandboxCommand({ profile: "agent_read_only", cwd: "/tmp/task", provider: "codex", codexRuntime: CODEX_RUNTIME_FIXTURE, command: { binary: "codex", args: ["--version"] } });
    expect(implement.args).toEqual(expect.arrayContaining(["--bind", "/tmp/task", "/project", "--ro-bind", "/tmp/base", "/tmp/base"]));
    expect(implement.args).toEqual(expect.arrayContaining(["--ro-bind", CODEX_RUNTIME_FIXTURE.stagedRuntimeRoot, "/opt/multiagents/codex"]));
    expect(review.args).toEqual(expect.arrayContaining(["--ro-bind", "/tmp/task", "/project"]));
    expect(review.args).not.toContain("--unshare-net");
    expect(() => buildSandboxCommand({ profile: "agent_read_only", cwd: "/tmp/task", writableRoot: "/tmp/task", provider: "codex", codexRuntime: CODEX_RUNTIME_FIXTURE, command: { binary: "codex", args: [] } })).toThrow(OsSandboxUnavailableError);
  });

  it("mounts only provider-specific credential files and excludes history, plugins, projects, and server state", () => {
    const cases = [
      buildSandboxCommand({ profile: "agent_read_only", cwd: "/tmp/task", provider: "codex", codexRuntime: CODEX_RUNTIME_FIXTURE, command: { binary: "codex", args: [] } }),
      buildSandboxCommand({ profile: "agent_read_only", cwd: "/tmp/task", provider: "cursor", cursorRuntime: CURSOR_RUNTIME_FIXTURE, command: { binary: "agent", args: [] } }),
      buildSandboxCommand({ profile: "agent_read_only", cwd: "/tmp/task", provider: "claude", claudeRuntime: CLAUDE_RUNTIME_FIXTURE, command: { binary: join(homedir(), ".local", "bin", "claude"), args: [] } }),
    ];
    const serialized = cases.map((item) => item.args.join("\0")).join("\n");
    expect(serialized).toContain("auth.json");
    expect(serialized).toContain(".credentials.json");
    for (const forbidden of ["history.jsonl", "/plugins", "/projects", ".multiagents", "state.db", "/home/justa\0/home/justa"]) expect(serialized).not.toContain(forbidden);
  });

  it("returns path-free public summaries", () => {
    const summary = publicOsSandboxPolicy("agent_implement");
    expect(summary).toMatchObject({ status: "enforced", filesystem: "isolated", home: "private", proc: "private", tmp: "private", wslInterop: "blocked", windowsMounts: "blocked", writeScope: "task_worktree_only", credentials: "provider_minimal_read_only" });
    expect(JSON.stringify(summary)).not.toContain(homedir());
  });

  it("fails closed for every non-pinned or missing backend", async () => {
    await expect(checkOsSandboxAvailability("/tmp/missing-bwrap")).rejects.toMatchObject({ failureCode: "backend_missing", message: expect.stringContaining("Task execution blocked") });
  });
});

describe("Phase 18 real bubblewrap enforcement", () => {
  let project: string;
  let base: string;
  let sibling: string;
  let hostTmpMarker: string;

  beforeAll(async () => {
    await checkOsSandboxAvailability();
    project = await mkdtemp(join(tmpdir(), "multiagents-sandbox-project-"));
    base = await mkdtemp(join(tmpdir(), "multiagents-sandbox-base-"));
    sibling = await mkdtemp(join(tmpdir(), "multiagents-sandbox-sibling-"));
    hostTmpMarker = join(tmpdir(), `multiagents-host-tmp-${process.pid}`);
    await writeFile(join(base, "base.txt"), "base\n");
    await writeFile(join(sibling, "sibling.txt"), "sibling\n");
    await writeFile(hostTmpMarker, "host tmp\n");
    await symlink(homedir(), join(project, "external-home"));
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([project, base, sibling, hostTmpMarker].filter(Boolean).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("enforces private HOME, tmp, proc, WSL blocking, hidden host state, and worktree-only writes", async () => {
    const raw = buildSandboxCommand({ profile: "validation", cwd: project, command: { binary: "/bin/sh", args: [] } });
    const script = [
      "set -eu",
      `test \"$HOME\" = ${SANDBOX_HOME}`,
      `test \"$PATH\" = ${SANDBOX_PATH}`,
      "test -z \"${WSL_INTEROP:-}\"",
      "test ! -e /init",
      "test ! -e /run/WSL",
      "for drive in c d e f g h i j k l m n o p q r s t u v w x y z; do test ! -e /mnt/$drive; done",
      "test ! -e /home/justa/.multiagents/state.db",
      "test ! -e /home/justa/.config/gh/hosts.yml",
      `test ! -e /proc/${process.pid}`,
      `test ! -e ${hostTmpMarker}`,
      "! command -v cmd.exe >/dev/null 2>&1",
      "! command -v powershell.exe >/dev/null 2>&1",
      "! command -v pwsh.exe >/dev/null 2>&1",
      "! /usr/bin/gh --version >/dev/null 2>&1",
      "! cat /project/external-home/.multiagents/state.db >/dev/null 2>&1",
      "touch /project/allowed.txt",
      "printf ISOLATED",
    ].join("\n");
    const result = await run(shellCommand(raw, script));
    expect(result).toMatchObject({ code: 0, stdout: "ISOLATED" });
    expect(await readFile(join(project, "allowed.txt"), "utf8")).toBe("");
  });

  it("lets a Codex implementation read and write its task worktree while base and sibling writes remain denied", async () => {
    const implement = shellCommand(buildSandboxCommand({ profile: "agent_implement", cwd: project, writableRoot: project, baseRepoRoot: base, provider: "codex", codexRuntime: CODEX_RUNTIME_FIXTURE, command: { binary: "codex", args: [] } }), [
      "set -eu", "printf codex-input > /project/codex-input.txt", "test \"$(cat /project/codex-input.txt)\" = codex-input", "printf codex-output > /project/implement.txt", "test \"$(cat /project/implement.txt)\" = codex-output", `test \"$(cat ${base}/base.txt)\" = base`, `! touch ${base}/forbidden`, `test ! -e ${sibling}`, "printf IMPLEMENT_OK",
    ].join("\n"));
    expect(await run(implement)).toMatchObject({ code: 0, stdout: "IMPLEMENT_OK" });

    const review = shellCommand(buildSandboxCommand({ profile: "agent_read_only", cwd: project, provider: "codex", codexRuntime: CODEX_RUNTIME_FIXTURE, command: { binary: "codex", args: [] } }), "! touch /project/review.txt && printf REVIEW_OK");
    expect(await run(review)).toMatchObject({ code: 0, stdout: "REVIEW_OK" });
  });

  it("denies validation access to both external and localhost networks", async () => {
    const server = createServer((_request, response) => response.end("reachable"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const raw = buildSandboxCommand({ profile: "validation", cwd: project, command: { binary: "/usr/bin/curl", args: ["--max-time", "1", `http://127.0.0.1:${port}`] } });
      expect((await run(raw)).code).not.toBe(0);
      const external = buildSandboxCommand({ profile: "validation", cwd: project, command: { binary: "/usr/bin/curl", args: ["--max-time", "1", "https://example.com"] } });
      expect((await run(external)).code).not.toBe(0);
    } finally { server.close(); }
  });

  it("contains a malicious package.json validation script while allowing normal project output", async () => {
    const attack = [
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      `for (const path of ['/home/justa/.multiagents/state.db', '/home/justa/.config/gh/hosts.yml', '${sibling}', '/proc/${process.pid}/environ']) { try { fs.readFileSync(path); process.exit(10); } catch {} }`,
      "for (const command of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'gh']) { if (cp.spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0) process.exit(11); }",
      "if (cp.spawnSync('/usr/bin/curl', ['--max-time', '1', 'https://example.com'], { stdio: 'ignore' }).status === 0) process.exit(12);",
      "fs.writeFileSync('validation-normal.txt', 'ok\\n');",
    ].join("\n");
    await writeFile(join(project, "phase18-attack.cjs"), attack);
    await writeFile(join(project, "phase18-normal.cjs"), "const fs=require('node:fs'); if(process.argv[2]==='build'&&process.env.NODE_ENV!=='production')process.exit(2); fs.writeFileSync(`normal-${process.argv[2]}.txt`,'ok\\n');\n");
    await writeFile(join(project, "package.json"), JSON.stringify({ scripts: {
      test: "node phase18-attack.cjs",
      lint: "node phase18-normal.cjs lint",
      typecheck: "node phase18-normal.cjs typecheck",
      build: "node phase18-normal.cjs build",
    } }));
    await runValidationCommand({ worktreePath: project } as RepoTask, "test", 10_000);
    expect(await readFile(join(project, "validation-normal.txt"), "utf8")).toBe("ok\n");
    for (const script of ["lint", "typecheck", "build"] as const) {
      await runValidationCommand({ worktreePath: project } as RepoTask, script, 10_000);
      expect(await readFile(join(project, `normal-${script}.txt`), "utf8")).toBe("ok\n");
    }
  });

  it("kills an escaped-session background descendant when the sandbox command completes", async () => {
    const raw = buildSandboxCommand({ profile: "validation", cwd: project, command: { binary: "/bin/sh", args: [] } });
    const result = await run(shellCommand(raw, "setsid /bin/sh -c 'trap \"\" TERM HUP; sleep 1; touch /project/orphan.txt' </dev/null >/dev/null 2>&1 & exit 0"));
    expect(result.code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await expect(readFile(join(project, "orphan.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps namespace startup overhead bounded", async () => {
    const started = performance.now();
    for (let index = 0; index < 3; index += 1) {
      const raw = buildSandboxCommand({ profile: "validation", cwd: project, command: { binary: "/bin/sh", args: ["-c", "true"] } });
      expect((await run(raw)).code).toBe(0);
    }
    expect((performance.now() - started) / 3).toBeLessThan(1_000);
  });
});
