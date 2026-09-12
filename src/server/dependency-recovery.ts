import type { RepoTask } from "./tasks";

/** Quote one POSIX shell word without ever interpreting the supplied path. */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * This only produces instructions for a recovery state that has already passed
 * server-side worktree recovery. It deliberately does not inspect or run a
 * package manager command.
 */
export function dependencyRecoveryInstructions(task: RepoTask) {
  if (
    task.dependencyRecovery !== "dependency_setup_required"
    || task.recoveryStatus !== "recoverable"
    || task.worktreeAvailable !== true
    || task.worktreeStatus !== "available"
  ) return undefined;

  return { command: `cd -- ${shellQuote(task.worktreePath)} && npm install` };
}
