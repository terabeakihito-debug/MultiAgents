import { agents } from "../agents";
import { agentIds, type AgentId } from "../agents/types";
import { buildGenericRuntimePolicy } from "../server/runtime-policy";

export const MAX_AGENT_RUN_PROMPT_LENGTH = 20_000;

type AgentRunMutationDependencies = {
  run: (
    agentId: AgentId,
    prompt: string,
    options: { signal?: AbortSignal; policy: ReturnType<typeof buildGenericRuntimePolicy> },
  ) => ReturnType<(typeof agents)[AgentId]["run"]>;
  buildPolicy: typeof buildGenericRuntimePolicy;
};

export class AgentRunUnknownAgentError extends Error {
  constructor(message = "Unknown agent") {
    super(message);
    this.name = "AgentRunUnknownAgentError";
  }
}

export class AgentRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunInputError";
  }
}

function safeAgentRunPrompt(prompt: string) {
  return `User request:\n${prompt}\n\nRespond with analysis or an answer only. Do not modify files, run git add, commit, push, create or approve a pull request, merge, deploy, change branches, or call MultiAgents approval or profile APIs.`;
}

export function createAgentRunMutationService(
  dependencies: AgentRunMutationDependencies = {
    run: (agentId, prompt, options) => agents[agentId].run(prompt, options),
    buildPolicy: buildGenericRuntimePolicy,
  },
) {
  return {
    async apply(
      agent: string,
      body: unknown,
      options: { signal?: AbortSignal } = {},
    ) {
      if (!agentIds.includes(agent as AgentId)) {
        throw new AgentRunUnknownAgentError();
      }

      const prompt = (body as { prompt?: unknown })?.prompt;
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new AgentRunInputError("Prompt is required");
      }
      if (prompt.length > MAX_AGENT_RUN_PROMPT_LENGTH) {
        throw new AgentRunInputError(
          `Prompt must be ${MAX_AGENT_RUN_PROMPT_LENGTH} characters or fewer`,
        );
      }

      const agentId = agent as AgentId;
      return dependencies.run(agentId, safeAgentRunPrompt(prompt), {
        signal: options.signal,
        policy: dependencies.buildPolicy(agentId),
      });
    },
  };
}

/** Framework-independent single-agent run mutation used by transport adapters. */
export const agentRunMutationService = createAgentRunMutationService();
