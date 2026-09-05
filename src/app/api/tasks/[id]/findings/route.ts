import { listTaskFindings } from "@/server/findings";
import { rejectNonLocalRequest } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  await initializeTaskRecovery();
  try { return Response.json({ findings: listTaskFindings((await context.params).id) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not load findings" }, { status: 404 }); }
}
