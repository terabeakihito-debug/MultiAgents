import { createReviewFlowStream } from "@/flows/review-stream";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";
const MAX_PROMPT_LENGTH = 20_000;

export async function POST(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;

  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return Response.json({ error: "Prompt is required" }, { status: 400 });
  if (prompt.length > MAX_PROMPT_LENGTH) return Response.json({ error: `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` }, { status: 400 });

  return new Response(createReviewFlowStream(prompt, request.signal), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
