import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

export function cursorArgs(prompt: string, cwd: string, repositoryTask: boolean, writeAccess: boolean) {
  return [
    "--trust", "--workspace", cwd,
    ...(repositoryTask && !writeAccess ? ["--mode", "ask", "--sandbox", "enabled"] : []),
    "-p", prompt,
  ];
}

export const cursorAgent = createAgentAdapter({
  id: "cursor",
  name: "Cursor",
  binary: "agent",
  args: cursorArgs,
}, { cwd: workspaceDirectory });
