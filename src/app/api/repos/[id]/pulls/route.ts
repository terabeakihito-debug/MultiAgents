import { listOpenPullRequests } from "@/server/pr-review";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try { return Response.json({ pulls: await listOpenPullRequests((await context.params).id) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not list pull requests" }, { status: 400 }); }
}
