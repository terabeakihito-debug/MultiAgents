import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

export const codexAgent = createAgentAdapter({
  id: "codex",
  name: "Codex",
  binary: "codex",
  args: (prompt, cwd) => ["exec", "--cd", cwd, prompt],
}, { cwd: workspaceDirectory });
