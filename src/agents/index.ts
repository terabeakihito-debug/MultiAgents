import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";
import { cursorAgent } from "./cursor";
import type { AgentAdapter, AgentId } from "./types";

export const agents: Record<AgentId, AgentAdapter> = {
  codex: codexAgent,
  cursor: cursorAgent,
  claude: claudeAgent,
};
