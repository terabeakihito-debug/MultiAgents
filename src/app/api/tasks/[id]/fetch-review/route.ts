import { fetchReviewIntake } from "@/server/pr-review";
import { ApprovalError } from "@/server/pull-request";
import { requireHumanMutation } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-fetch-review", { label: "PR review fetch" });
  if (rejection) return rejection;
  await initializeTaskRecovery();
  try { return Response.json({ task: await fetchReviewIntake((await context.params).id) }); }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "PR review fetch failed" }, { status: error instanceof ApprovalError ? error.statusCode : 409 });
  }
}
