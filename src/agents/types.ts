export const agentIds = ["codex", "cursor", "claude"] as const;

export type AgentId = (typeof agentIds)[number];
export type AgentStatus = "idle" | "running" | "completed" | "error";

export type AgentResult = {
  agent: AgentId;
  status: "completed" | "error";
  output: string;
  error?: string;
};

export type AgentDefinition = {
  id: AgentId;
  name: string;
  binary: string;
  args: (prompt: string, cwd: string) => string[];
};

export type AgentRunOptions = { signal?: AbortSignal };

export type AgentAdapter = {
  id: AgentId;
  name: string;
  run: (prompt: string, options?: AgentRunOptions) => Promise<AgentResult>;
};
