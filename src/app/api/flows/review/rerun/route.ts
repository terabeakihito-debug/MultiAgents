import { createReviewRerunStream, parseReviewRerunRequest } from "@/flows/review-rerun";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const parsed = parseReviewRerunRequest(body);
  if ("error" in parsed) return Response.json(parsed, { status: 400 });
  return new Response(createReviewRerunStream(parsed, request.signal), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
