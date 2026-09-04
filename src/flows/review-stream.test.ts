import { describe, expect, it, vi } from "vitest";
import type { ReviewFlowResult } from "../agents/types";
import { createReviewFlowStream } from "./review-stream";

describe("createReviewFlowStream", () => {
  it("aborts the running flow when the browser disconnects", async () => {
    let flowSignal: AbortSignal | undefined;
    const stopped = vi.fn();
    const runner = vi.fn((_prompt, options) => {
      flowSignal = options.signal;
      return new Promise<ReviewFlowResult>((resolve) => options.signal.addEventListener("abort", () => {
        stopped();
        resolve({ flowId: "flow-1", status: "aborted", steps: [], finalOutput: "" });
      }, { once: true }));
    });
    const stream = createReviewFlowStream("safe", new AbortController().signal, runner);
    await stream.getReader().cancel("disconnected");
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
    expect(flowSignal?.aborted).toBe(true);
  });
});
