import { describe, expect, it, vi } from "vitest";
import {
  connectGitHubWithToken,
  loadGitHubAccount,
  parseGhAuthLogin,
  setGitHubAccountGhInputRunnerForTests,
  setGitHubAccountGhRunnerForTests,
} from "./github-account";
import type { FixedProcessResult } from "./pull-request";

function ghResult(partial: Partial<FixedProcessResult> & Pick<FixedProcessResult, "code">): FixedProcessResult {
  return {
    stdout: "",
    stderr: "",
    signal: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...partial,
  };
}

describe("github account", () => {
  it("parses the active GitHub CLI login from auth status output", () => {
    expect(parseGhAuthLogin("✓ Logged in to github.com account cursor (/path/hosts.yml)")).toBe("cursor");
    expect(parseGhAuthLogin("not logged in")).toBeUndefined();
  });

  it("reports connected when gh auth status succeeds", async () => {
    setGitHubAccountGhRunnerForTests(async () => ghResult({
      code: 0,
      stdout: "✓ Logged in to github.com account demo-user (/tmp/hosts.yml)",
    }));
    await expect(loadGitHubAccount()).resolves.toMatchObject({
      connected: true,
      login: "demo-user",
      hostname: "github.com",
    });
    setGitHubAccountGhRunnerForTests(null);
  });

  it("reports disconnected when gh auth status fails", async () => {
    setGitHubAccountGhRunnerForTests(async () => ghResult({ code: 1, stderr: "not logged in" }));
    await expect(loadGitHubAccount()).resolves.toMatchObject({ connected: false, hostname: "github.com" });
    setGitHubAccountGhRunnerForTests(null);
  });

  it("connects with a token through gh auth login --with-token", async () => {
    const runner = vi.fn(async (args: readonly string[]) => {
      if (args.includes("status")) {
        return ghResult({ code: 0, stdout: "✓ Logged in to github.com account demo-user (/tmp/hosts.yml)" });
      }
      return ghResult({ code: 0, stdout: "" });
    });
    setGitHubAccountGhRunnerForTests(runner);
    setGitHubAccountGhInputRunnerForTests(async (args, _cwd, input) => {
      expect(args).toEqual(["auth", "login", "--hostname", "github.com", "--with-token"]);
      expect(input).toBe("ghp_testtoken\n");
      return ghResult({ code: 0 });
    });
    await expect(connectGitHubWithToken("ghp_testtoken")).resolves.toMatchObject({
      connected: true,
      login: "demo-user",
    });
    setGitHubAccountGhRunnerForTests(null);
    setGitHubAccountGhInputRunnerForTests(null);
  });
});
