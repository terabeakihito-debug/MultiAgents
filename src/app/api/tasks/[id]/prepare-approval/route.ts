import { prepareApproval } from "@/server/pull-request";
import { requireHumanMutation } from "@/server/request-security";
import { getTask, getTaskDiff, initializeTaskRecovery, publicTask } from "@/server/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-prepare-approval", { label: "Approval snapshot" });
  if (rejection) return rejection;
  await initializeTaskRecovery();
  const task = getTask((await context.params).id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  if (!task.worktreeAvailable) return Response.json({
    diff: { trackedFiles: [], untrackedFiles: [], stat: "", patch: "", untrackedPatch: "", truncated: false, approvable: false, blockedReason: "Managed task worktree is unavailable in this review-only session." },
    task: publicTask(task),
  });
  try { return Response.json(await prepareApproval(task)); }
  catch (error) {
    return Response.json({ diff: await getTaskDiff(task), task: publicTask(task), error: error instanceof Error ? error.message : "Could not prepare approval" }, { status: 409 });
  }
}
