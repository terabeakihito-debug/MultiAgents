import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

export function cursorArgs(prompt: string, cwd: string, _repositoryTask: boolean, _writeAccess: boolean) {
  void _repositoryTask; void _writeAccess;
  return [
    "--trust", "--workspace", cwd, "--skip-worktree-setup",
    "--mode", "ask", "--sandbox", "enabled",
    "-p", prompt,
  ];
}

export const cursorAgent = createAgentAdapter({
  id: "cursor",
  name: "Cursor",
  binary: "agent",
  args: cursorArgs,
}, { cwd: workspaceDirectory });
