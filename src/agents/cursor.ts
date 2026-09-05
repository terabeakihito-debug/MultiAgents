import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

export function cursorArgs(prompt: string, cwd: string, _repositoryTask: boolean, writeAccess: boolean) {
  return [
    "--trust", "--workspace", cwd,
    ...(!writeAccess ? ["--mode", "ask", "--sandbox", "enabled"] : []),
    "-p", prompt,
  ];
}

export const cursorAgent = createAgentAdapter({
  id: "cursor",
  name: "Cursor",
  binary: "agent",
  args: cursorArgs,
}, { cwd: workspaceDirectory });
