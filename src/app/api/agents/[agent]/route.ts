import { agents } from "@/agents";
import { agentIds, type AgentId } from "@/agents/types";
import { rejectNonLocalRequest } from "@/server/request-security";
import { buildGenericRuntimePolicy } from "@/server/runtime-policy";

export const runtime = "nodejs";

const MAX_PROMPT_LENGTH = 20_000;

export async function POST(
  request: Request,
  context: { params: Promise<{ agent: string }> },
) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;

  const { agent } = await context.params;
  if (!agentIds.includes(agent as AgentId)) {
    return Response.json({ error: "Unknown agent" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return Response.json({ error: "Prompt is required" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return Response.json({ error: `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` }, { status: 400 });
  }

  const safePrompt = `User request:\n${prompt}\n\nRespond with analysis or an answer only. Do not modify files, run git add, commit, push, create or approve a pull request, merge, deploy, change branches, or call MultiAgents approval or profile APIs.`;
  const id = agent as AgentId;
  const result = await agents[id].run(safePrompt, { signal: request.signal, policy: buildGenericRuntimePolicy(id) });
  return Response.json(result);
}
