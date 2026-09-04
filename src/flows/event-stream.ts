import type { StreamEvent } from "../agents/types";
import { encodeFlowEvent } from "./sse";

export type StreamRun = (options: { signal: AbortSignal; send: (event: StreamEvent) => void }) => Promise<unknown>;

export function createEventStream(requestSignal: AbortSignal, run: StreamRun, logName: string) {
  const controllerForRun = new AbortController();
  const abortFromRequest = () => controllerForRun.abort(requestSignal.reason);
  requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: StreamEvent) => {
        if (closed) return;
        controller.enqueue(encodeFlowEvent(event));
        const step = "step" in event ? event.step : undefined;
        console.info(logName, JSON.stringify({
          flowId: event.flowId,
          rerunId: "rerunId" in event ? event.rerunId : undefined,
          eventType: event.type,
          stepId: step?.id ?? ("stepId" in event ? event.stepId : undefined),
          agent: step?.agent,
          status: step?.status,
          durationMs: step?.durationMs,
        }));
      };
      void run({ signal: controllerForRun.signal, send }).then(() => {
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
      controllerForRun.abort(reason ?? new Error("Event stream disconnected"));
    },
  }, { highWaterMark: 1 });
}
