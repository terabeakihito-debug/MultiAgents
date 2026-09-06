import { ApprovalError, retryPullRequest } from "@/server/pull-request";
import { requireHumanMutation } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-create-pr", { label: "PR creation" });
  if (rejection) return rejection;
  await initializeTaskRecovery();
  try {
    const task = await retryPullRequest((await context.params).id);
    return Response.json({ task });
  } catch (error) {
    const status = error instanceof ApprovalError ? error.statusCode : 409;
    return Response.json({ error: error instanceof Error ? error.message : "PR retry failed" }, { status });
  }
}
