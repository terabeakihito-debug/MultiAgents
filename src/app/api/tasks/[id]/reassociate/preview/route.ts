import { previewManagedWorktreeReassociation } from "@/server/tasks";
import { requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-reassociation-preview", { label: "Worktree reassociation preview" }); if (rejection) return rejection;
  try { return Response.json({ preview: await previewManagedWorktreeReassociation((await context.params).id) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Reassociation preview failed" }, { status: 409 }); }
}
