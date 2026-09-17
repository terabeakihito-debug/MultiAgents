import { describe, expect, it, vi } from "vitest";
import { createAgentParallelRunMutationService } from "./agent-parallel-run-mutation-service";

describe("agent parallel run mutation service", () => {
  it("runs every configured agent and returns results", async () => {
    const run = vi.fn(async (agentId: string) => ({
      agentId,
      status: "completed",
    })) as never;
    const buildPolicy = vi.fn(() => ({})) as never;
    const service = createAgentParallelRunMutationService({
      run,
      buildPolicy,
      listAgents: ["codex", "cursor"] as never,
    });

    await expect(service.apply({ prompt: "hello" })).resolves.toEqual({
      results: [
        { agentId: "codex", status: "completed" },
        { agentId: "cursor", status: "completed" },
      ],
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
