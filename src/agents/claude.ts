import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

const CLAUDE_HOME = process.env.HOME || homedir();
const CLAUDE_BINARY = join(CLAUDE_HOME, ".local", "bin", "claude");

export function claudeArgs(prompt: string, _cwd: string, _repositoryTask: boolean, _writeAccess: boolean) {
  void _cwd; void _repositoryTask; void _writeAccess;
  return [
    "--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome",
    "--permission-mode", "plan", "--permission-prompts", "none", "--tools", "Read,Glob,Grep",
    "-p", prompt,
  ];
}

export const claudeAgent = createAgentAdapter({
  id: "claude",
  name: "Claude",
  binary: CLAUDE_BINARY,
  args: claudeArgs,
}, { cwd: workspaceDirectory });
