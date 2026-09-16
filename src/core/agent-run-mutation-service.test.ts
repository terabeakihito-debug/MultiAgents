import { describe, expect, it, vi } from "vitest";
import {
  AgentRunInputError,
  AgentRunUnknownAgentError,
  createAgentRunMutationService,
} from "./agent-run-mutation-service";

describe("agent run mutation service", () => {
  it("rejects unknown agents", async () => {
    const service = createAgentRunMutationService({
      run: vi.fn(),
      buildPolicy: vi.fn(() => ({})) as never,
    });

    await expect(
      service.apply("unknown", { prompt: "hello" }),
    ).rejects.toBeInstanceOf(AgentRunUnknownAgentError);
  });

  it("runs a known agent with a sanitized prompt", async () => {
    const run = vi.fn(async () => ({ status: "completed" })) as never;
    const buildPolicy = vi.fn(() => ({ mode: "generic" })) as never;
    const service = createAgentRunMutationService({ run, buildPolicy });

    await expect(service.apply("codex", { prompt: "hello" })).resolves.toEqual({
      status: "completed",
    });
    expect(run).toHaveBeenCalledWith(
      "codex",
      expect.stringContaining("User request:\nhello"),
      expect.objectContaining({ policy: { mode: "generic" } }),
    );
  });

  it("requires a non-empty prompt", async () => {
    const service = createAgentRunMutationService({
      run: vi.fn(),
      buildPolicy: vi.fn(() => ({})) as never,
    });

    await expect(service.apply("codex", { prompt: "  " })).rejects.toBeInstanceOf(
      AgentRunInputError,
    );
  });
});
