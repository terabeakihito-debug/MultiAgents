import type { FlowEvent, ReviewFlowResult } from "../agents/types";
import { runReviewFlow } from "./review";
import { encodeFlowEvent } from "./sse";

type ReviewRunner = (prompt: string, options: { signal: AbortSignal; onEvent: (event: FlowEvent) => void; log: (entry: { flowId: string; stepId: string; agent: string; status: string; durationMs?: number }) => void }) => Promise<ReviewFlowResult>;

export function createReviewFlowStream(prompt: string, requestSignal: AbortSignal, runner: ReviewRunner = runReviewFlow) {
  const flowController = new AbortController();
  const abortFromRequest = () => flowController.abort(requestSignal.reason);
  requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: FlowEvent) => {
        if (closed) return;
        controller.enqueue(encodeFlowEvent(event));
        const step = "step" in event ? event.step : undefined;
        console.info("review_flow_event", JSON.stringify({ flowId: event.flowId, eventType: event.type, stepId: step?.id, agent: step?.agent, status: step?.status, durationMs: step?.durationMs }));
      };
      void runner(prompt, {
        signal: flowController.signal,
        onEvent: send,
        log: () => undefined,
      }).then(() => {
        if (!closed) controller.close();
      }).catch((error: unknown) => {
        if (!closed) controller.error(error);
      }).finally(() => {
        closed = true;
        requestSignal.removeEventListener("abort", abortFromRequest);
      });
    },
    cancel(reason) {
      closed = true;
      requestSignal.removeEventListener("abort", abortFromRequest);
      flowController.abort(reason ?? new Error("Review flow stream disconnected"));
    },
  }, { highWaterMark: 1 });
}
