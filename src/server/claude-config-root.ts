import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export const CLAUDE_CONFIG_ROOT = join(homedir(), ".local", "share", "multiagents", "claude");
export const SANDBOX_CLAUDE_CONFIG_ROOT = "/run/multiagents/claude" as const;

export type ClaudeConfigRootStatus = "ready" | "setup_required" | "unsupported_layout";
export class ClaudeConfigRootError extends Error { constructor(public readonly status: Exclude<ClaudeConfigRootStatus, "ready">) { super(status === "setup_required" ? "Claude setup required" : "Claude configuration layout is unsafe"); } }

/** Validates the server-owned root and parent chain only. Claude owns its internal layout. */
export function validateClaudeConfigRoot(): string {
  const root = CLAUDE_CONFIG_ROOT;
  if (!root.startsWith("/") || root.includes("\0") || /^\/mnt\/[a-z](?:\/|$)/i.test(root)) throw new ClaudeConfigRootError("unsupported_layout");
  validateParents(root);
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(root); } catch { throw new ClaudeConfigRootError("setup_required"); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new ClaudeConfigRootError("unsupported_layout");
  try { if (realpathSync(root) !== root) throw new Error(); } catch { throw new ClaudeConfigRootError("unsupported_layout"); }
  return root;
}

function validateParents(root: string) {
  const home = resolve(homedir());
  if (!root.startsWith(`${home}${sep}`) || root === home) throw new ClaudeConfigRootError("unsupported_layout");
  let current = home;
  for (const segment of relative(home, root).split(sep)) {
    try { const info = lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(); } catch { throw new ClaudeConfigRootError("unsupported_layout"); }
    current = join(current, segment);
  }
}
