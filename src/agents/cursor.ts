import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

export const cursorAgent = createAgentAdapter({
  id: "cursor",
  name: "Cursor",
  binary: "agent",
  args: (prompt, cwd) => ["--trust", "--workspace", cwd, "-p", prompt],
}, { cwd: workspaceDirectory });
