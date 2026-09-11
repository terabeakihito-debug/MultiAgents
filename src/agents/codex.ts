import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

export function codexArgs(prompt: string, cwd: string, repositoryTask: boolean, writeAccess = repositoryTask) {
  const implement = repositoryTask && writeAccess;
  // The outer Bubblewrap profile is the authoritative filesystem boundary.
  // Codex's Linux workspace-write sandbox needs to create a nested namespace,
  // which is unavailable from our already-unshared provider namespace.  Bypass
  // only that inner sandbox for implementation runs; Bubblewrap still exposes
  // exactly one writable mount, /project (the managed task worktree).
  return ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", ...(implement ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "read-only"]), "--cd", cwd, prompt];
}

export const codexAgent = createAgentAdapter({
  id: "codex",
  name: "Codex",
  binary: "codex",
  args: codexArgs,
}, { cwd: workspaceDirectory });
