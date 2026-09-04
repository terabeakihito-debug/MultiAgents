import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentAdapter } from "./runner";
import { workspaceDirectory } from "./workspace";

const CLAUDE_HOME = process.env.HOME || homedir();
const CLAUDE_BINARY = join(CLAUDE_HOME, ".local", "bin", "claude");

export const claudeAgent = createAgentAdapter({
  id: "claude",
  name: "Claude",
  binary: CLAUDE_BINARY,
  args: (prompt) => ["-p", prompt],
}, {
  cwd: workspaceDirectory,
  env: {
    ...process.env,
    HOME: CLAUDE_HOME,
    PATH: process.env.PATH,
  },
});
