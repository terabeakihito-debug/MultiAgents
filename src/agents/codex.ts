import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

export function codexArgs(prompt: string, cwd: string, repositoryTask: boolean, writeAccess = repositoryTask) {
  return ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", repositoryTask && writeAccess ? "workspace-write" : "read-only", "--cd", cwd, prompt];
}

export const codexAgent = createAgentAdapter({
  id: "codex",
  name: "Codex",
  binary: "codex",
  args: codexArgs,
}, { cwd: workspaceDirectory });
