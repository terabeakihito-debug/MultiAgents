import type { FlowEvent, ReviewFlowResult } from "../agents/types";
import { runReviewFlow } from "./review";
import { createEventStream } from "./event-stream";

type ReviewRunner = (prompt: string, options: { signal: AbortSignal; onEvent: (event: FlowEvent) => void; log: (entry: { flowId: string; stepId: string; agent: string; status: string; durationMs?: number }) => void }) => Promise<ReviewFlowResult>;

export function createReviewFlowStream(prompt: string, requestSignal: AbortSignal, runner: ReviewRunner = runReviewFlow) {
  return createEventStream(requestSignal, ({ signal, send }) => runner(prompt, {
        signal,
        onEvent: (event) => send(event),
        log: () => undefined,
      }), "review_flow_event");
}
