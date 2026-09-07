import { previewCleanup } from "@/server/cleanup";
import { requireHumanMutation } from "@/server/request-security";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "cleanup-preview", { label: "Cleanup preview" }); if (rejection) return rejection;
  let body: { candidateIds?: unknown }; try { body = await request.json(); } catch { return Response.json({ error: "Cleanup selection must be valid JSON" }, { status: 400 }); }
  try { return Response.json(await previewCleanup(Array.isArray(body.candidateIds) ? body.candidateIds as string[] : [])); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Cleanup preview failed" }, { status: 409 }); }
}
