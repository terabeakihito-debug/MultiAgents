import { describe, expect, it } from "vitest";
import { buildChildProcessEnv, buildServerGitMutationEnv, type ChildProcessPurpose } from "./child-process-env";
import { runHardenedProcess } from "./pull-request";

const fixture = "TEST_SECRET_DO_NOT_LEAK";
const parent = {
  PATH: "/usr/bin",
  HOME: "/home/test",
  USER: "test",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  XDG_CONFIG_HOME: "/home/test/.config",
  CODEX_HOME: "/home/test/.codex",
  CLAUDE_CONFIG_DIR: "/home/test/.claude",
  CURSOR_CONFIG_DIR: "/home/test/.cursor",
  GH_CONFIG_DIR: "/home/test/.config/gh",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  MULTIAGENTS_SLACK_WEBHOOK_URL: fixture,
  OPENAI_API_KEY: fixture,
  SERVICE_TOKEN: fixture,
  DATABASE_PASSWORD: fixture,
  AUTHORIZATION: fixture,
};

describe("Phase 16 child process environment isolation", () => {
  it.each(["agent", "validation", "git", "github"] as ChildProcessPurpose[])("removes server and pattern-matched secrets for %s", (purpose) => {
    const env = buildChildProcessEnv({ purpose, baseEnv: parent });
    expect(JSON.stringify(env)).not.toContain(fixture);
    expect(env.PATH).toBe(parent.PATH);
    expect(env.HOME).toBe(parent.HOME);
  });

  it("preserves filesystem-backed CLI authentication paths only for agents", () => {
    const agent = buildChildProcessEnv({ purpose: "agent", baseEnv: parent });
    expect(agent).toMatchObject({ HOME: parent.HOME, PATH: parent.PATH, XDG_CONFIG_HOME: parent.XDG_CONFIG_HOME, CODEX_HOME: parent.CODEX_HOME, CLAUDE_CONFIG_DIR: parent.CLAUDE_CONFIG_DIR, CURSOR_CONFIG_DIR: parent.CURSOR_CONFIG_DIR });
    expect(agent).not.toHaveProperty("GH_CONFIG_DIR");
  });

  it("preserves external git and gh auth brokers without credential values", () => {
    const git = buildChildProcessEnv({ purpose: "git", baseEnv: parent });
    const github = buildChildProcessEnv({ purpose: "github", baseEnv: parent });
    expect(git.SSH_AUTH_SOCK).toBe(parent.SSH_AUTH_SOCK);
    expect(github).toMatchObject({ HOME: parent.HOME, GH_CONFIG_DIR: parent.GH_CONFIG_DIR, SSH_AUTH_SOCK: parent.SSH_AUTH_SOCK });
  });

  it("does not expose the Slack secret to a validation subprocess", async () => {
    const env = buildChildProcessEnv({ purpose: "validation", baseEnv: { ...process.env, MULTIAGENTS_SLACK_WEBHOOK_URL: fixture } });
    const result = await runHardenedProcess({
      binary: process.execPath, args: ["-e", "require('node:fs').writeSync(1, process.env.MULTIAGENTS_SLACK_WEBHOOK_URL || 'ABSENT')"],
      cwd: process.cwd(), env, purpose: "validation", timeoutMs: 5_000, terminateOnOutput: false,
    });
    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: "ABSENT" });
  });

  it("cannot reintroduce a secret through overrides", () => {
    const env = buildChildProcessEnv({ purpose: "validation", baseEnv: parent, overrides: { SERVICE_TOKEN: fixture, NODE_ENV: "production" } });
    expect(env.NODE_ENV).toBe("production");
    expect(env.SERVICE_TOKEN).toBeUndefined();
  });

  it("isolates server Git mutations from config and repository path injection", () => {
    const env = buildServerGitMutationEnv({
      HOME: "/home/test", PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/user/1000/agent",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/tmp/hooks",
      GIT_DIR: "/tmp/evil.git", GIT_WORK_TREE: "/tmp/evil", GIT_INDEX_FILE: "/tmp/index",
      GIT_SSH_COMMAND: "/tmp/evil-ssh", GIT_ASKPASS: "/tmp/askpass",
    });
    expect(env).toMatchObject({ HOME: "/home/test", PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/user/1000/agent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" });
    expect(Object.keys(env).some((key) => key === "GIT_CONFIG_COUNT" || key.startsWith("GIT_CONFIG_KEY_"))).toBe(false);
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_SSH_COMMAND", "GIT_ASKPASS"]) expect(env).not.toHaveProperty(key);
  });
});
