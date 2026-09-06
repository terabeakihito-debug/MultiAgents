import { refreshPullRequestStatus } from "@/server/pr-review";
import { ApprovalError } from "@/server/pull-request";
import { requireHumanMutation } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-refresh-pr", { label: "PR status refresh" });
  if (rejection) return rejection;
  await initializeTaskRecovery();
  try {
    return Response.json({ task: await refreshPullRequestStatus((await context.params).id) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "PR status refresh failed" }, { status: error instanceof ApprovalError ? error.statusCode : 409 });
  }
}
