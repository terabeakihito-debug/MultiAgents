import { reviewService, ReviewRequestError } from "@/core/review-service";
import { requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "review-run", { label: "Review execution" });
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  let reviewRequest;
  try {
    reviewRequest = reviewService.parseRequest(body);
  } catch (error) {
    if (error instanceof ReviewRequestError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }

  const flow = await reviewService.run(reviewRequest, {
    signal: request.signal,
    log: ({ flowId, stepId, agent, status, durationMs }) => console.info("review_flow", JSON.stringify({ flowId, stepId, agent, status, durationMs })),
  });
  return Response.json(flow);
}
