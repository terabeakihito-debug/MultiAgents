import type { FlowEvent, ReviewFlowResult } from "../agents/types";
import type { RolePolicy } from "../profiles/policy";
import { runReviewFlow } from "./review";
import { createEventStream } from "./event-stream";

type StreamOptions = { cwd?: string; getDiff?: () => Promise<string>; fingerprint?: () => Promise<string>; roles?: RolePolicy; onComplete?: (result: ReviewFlowResult) => void; onEvent?: (event: FlowEvent) => void };
type ReviewRunner = (prompt: string, options: { signal: AbortSignal; onEvent: (event: FlowEvent) => void; log: (entry: { flowId: string; stepId: string; agent: string; status: string; durationMs?: number }) => void; cwd?: string; getDiff?: () => Promise<string>; fingerprint?: () => Promise<string>; roles?: RolePolicy }) => Promise<ReviewFlowResult>;

export function createReviewFlowStream(prompt: string, requestSignal: AbortSignal, runner: ReviewRunner = runReviewFlow, options: StreamOptions = {}) {
  const { onComplete, onEvent, ...runnerOptions } = options;
  return createEventStream(requestSignal, async ({ signal, send }) => {
    const result = await runner(prompt, {
        signal,
        onEvent: (event) => { onEvent?.(event); send(event); },
        log: () => undefined,
        ...runnerOptions,
      });
    onComplete?.(result);
    return result;
  }, "review_flow_event");
}
