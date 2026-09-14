import { afterEach, describe, expect, it } from "vitest";
import { ClaudeConfigRootError, setClaudeConfigRootTestSeamForTests, validateClaudeConfigRoot } from "./claude-config-root";

const home = "/home/server";
const root = `${home}/.local/share/multiagents/claude`;
const parents = [home, `${home}/.local`, `${home}/.local/share`, `${home}/.local/share/multiagents`];
const uid = process.getuid!();

type Overrides = Record<string, Partial<{ directory: boolean; symlink: boolean; uid: number; mode: number }>>;
function install(overrides: Overrides = {}) {
  setClaudeConfigRootTestSeamForTests({
    home,
    root,
    lstat: (path) => {
      const override = overrides[path] ?? {};
      return {
        isDirectory: () => override.directory ?? true,
        isSymbolicLink: () => override.symlink ?? false,
        uid: override.uid ?? uid,
        mode: override.mode ?? (path === root ? 0o700 : 0o755),
      };
    },
    realpath: (path) => path,
  });
}

afterEach(() => setClaudeConfigRootTestSeamForTests(undefined));

describe("Claude dedicated config root validation", () => {
  it("accepts server-owned non-writable parents", () => {
    install({ [parents[1]]: { mode: 0o750 } });
    expect(validateClaudeConfigRoot()).toBe(root);
  });

  it.each([
    ["a foreign-owned parent", { [parents[2]]: { uid: uid + 1 } }],
    ["a group-writable parent", { [parents[2]]: { mode: 0o775 } }],
    ["a world-writable parent", { [parents[2]]: { mode: 0o757 } }],
    ["a parent symlink", { [parents[2]]: { symlink: true } }],
  ])("fails closed for %s", (_name, overrides) => {
    install(overrides);
    expect(() => validateClaudeConfigRoot()).toThrow(ClaudeConfigRootError);
  });

  it.each([0o755, 0o750, 0o600])("keeps the root exact-0700 requirement (%o)", (mode) => {
    install({ [root]: { mode } });
    expect(() => validateClaudeConfigRoot()).toThrow(ClaudeConfigRootError);
  });
});
