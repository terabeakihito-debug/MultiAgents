import { recoverExistingPullRequestTask } from "@/server/pr-review";
import { ApprovalError } from "@/server/pull-request";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const value = body as { repoId?: unknown; prNumber?: unknown };
  if (typeof value.repoId !== "string" || !Number.isSafeInteger(value.prNumber) || Number(value.prNumber) < 1) return Response.json({ error: "Repository and numeric PR number are required" }, { status: 400 });
  try { return Response.json({ task: await recoverExistingPullRequestTask(value.repoId, Number(value.prNumber)) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "PR task recovery failed" }, { status: error instanceof ApprovalError ? error.statusCode : 409 }); }
}
