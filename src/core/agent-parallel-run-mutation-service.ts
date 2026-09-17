import { agents } from "../agents";
import { agentIds, type AgentId } from "../agents/types";
import { buildGenericRuntimePolicy } from "../server/runtime-policy";
import {
  AgentRunInputError,
  MAX_AGENT_RUN_PROMPT_LENGTH,
} from "./agent-run-mutation-service";

type AgentParallelRunMutationDependencies = {
  run: (
    agentId: AgentId,
    prompt: string,
    options: { signal?: AbortSignal; policy: ReturnType<typeof buildGenericRuntimePolicy> },
  ) => ReturnType<(typeof agents)[AgentId]["run"]>;
  buildPolicy: typeof buildGenericRuntimePolicy;
  listAgents: readonly AgentId[];
};

function safeAgentRunPrompt(prompt: string) {
  return `User request:\n${prompt}\n\nRespond with analysis or an answer only. Do not modify files, run git add, commit, push, create or approve a pull request, merge, deploy, change branches, or call MultiAgents approval or profile APIs.`;
}

function parsePrompt(body: unknown) {
  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new AgentRunInputError("Prompt is required");
  }
  if (prompt.length > MAX_AGENT_RUN_PROMPT_LENGTH) {
    throw new AgentRunInputError(
      `Prompt must be ${MAX_AGENT_RUN_PROMPT_LENGTH} characters or fewer`,
    );
  }
  return prompt;
}

export function createAgentParallelRunMutationService(
  dependencies: AgentParallelRunMutationDependencies = {
    run: (agentId, prompt, options) => agents[agentId].run(prompt, options),
    buildPolicy: buildGenericRuntimePolicy,
    listAgents: agentIds,
  },
) {
  return {
    async apply(body: unknown, options: { signal?: AbortSignal } = {}) {
      const safePrompt = safeAgentRunPrompt(parsePrompt(body));
      const results = await Promise.all(
        dependencies.listAgents.map((id) =>
          dependencies.run(id, safePrompt, {
            signal: options.signal,
            policy: dependencies.buildPolicy(id),
          }),
        ),
      );
      return { results };
    },
  };
}

/** Framework-independent parallel agent run mutation used by transport adapters. */
export const agentParallelRunMutationService =
  createAgentParallelRunMutationService();
