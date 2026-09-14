import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export const CLAUDE_CONFIG_ROOT = join(homedir(), ".local", "share", "multiagents", "claude");
export const SANDBOX_CLAUDE_CONFIG_ROOT = "/run/multiagents/claude" as const;

export type ClaudeConfigRootStatus = "ready" | "setup_required" | "unsupported_layout";
export class ClaudeConfigRootError extends Error { constructor(public readonly status: Exclude<ClaudeConfigRootStatus, "ready">) { super(status === "setup_required" ? "Claude setup required" : "Claude configuration layout is unsafe"); } }

type RootStat = {
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  uid: number;
  mode: number;
};
type ClaudeConfigRootTestSeam = {
  home: string;
  root: string;
  lstat: (path: string) => RootStat;
  realpath: (path: string) => string;
};
let testSeam: ClaudeConfigRootTestSeam | undefined;

/** Test-only metadata seam. Production callers cannot select a credential source path. */
export function setClaudeConfigRootTestSeamForTests(seam: ClaudeConfigRootTestSeam | undefined) {
  if (process.env.NODE_ENV !== "test") throw new Error("Claude config root test seam is unavailable outside tests");
  testSeam = seam;
}

/** Validates the server-owned root and parent chain only. Claude owns its internal layout. */
export function validateClaudeConfigRoot(): string {
  const root = testSeam?.root ?? CLAUDE_CONFIG_ROOT;
  if (!root.startsWith("/") || root.includes("\0") || /^\/mnt\/[a-z](?:\/|$)/i.test(root)) throw new ClaudeConfigRootError("unsupported_layout");
  validateParents(root);
  let info: RootStat;
  try { info = (testSeam?.lstat ?? lstatSync)(root) as RootStat; } catch { throw new ClaudeConfigRootError("setup_required"); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new ClaudeConfigRootError("unsupported_layout");
  try { if ((testSeam?.realpath ?? realpathSync)(root) !== root) throw new Error(); } catch { throw new ClaudeConfigRootError("unsupported_layout"); }
  return root;
}

function validateParents(root: string) {
  const home = resolve(testSeam?.home ?? homedir());
  if (!root.startsWith(`${home}${sep}`) || root === home) throw new ClaudeConfigRootError("unsupported_layout");
  let current = home;
  for (const segment of relative(home, root).split(sep)) {
    try {
      const info = (testSeam?.lstat ?? lstatSync)(current);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error();
    } catch { throw new ClaudeConfigRootError("unsupported_layout"); }
    current = join(current, segment);
  }
}
