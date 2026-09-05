import { approveRework } from "@/server/pr-review";
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
  const value = body as { approved?: unknown; diffHash?: unknown; approvalId?: unknown };
  if (value?.approved !== true || typeof value.diffHash !== "string" || typeof value.approvalId !== "string") {
    return Response.json({ error: "Explicit approval, diffHash, and approvalId are required" }, { status: 400 });
  }
  try {
    const task = await approveRework((await context.params).id, { approved: true, diffHash: value.diffHash, approvalId: value.approvalId });
    return Response.json({ task });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Rework approval failed" }, { status: error instanceof ApprovalError ? error.statusCode : 409 });
  }
}
