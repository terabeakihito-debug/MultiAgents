import { applyReviewedFixes } from "@/server/pr-review";
import { ApprovalError } from "@/server/pull-request";
import { rejectNonLocalRequest } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  await initializeTaskRecovery();
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if ((body as { approved?: unknown })?.approved !== true) return Response.json({ error: "Explicit human approval is required" }, { status: 400 });
  try { return Response.json({ task: await applyReviewedFixes((await context.params).id, { approved: true }) }); }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "PR rework failed" }, { status: error instanceof ApprovalError ? error.statusCode : 409 });
  }
}
