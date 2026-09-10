import { reassociateManagedWorktree, publicTask } from "@/server/tasks";
import { requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-reassociation-confirm", { label: "Worktree reassociation" }); if (rejection) return rejection;
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  const value = body as { confirmed?: unknown; fingerprint?: unknown };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(value).length !== 2 || value.confirmed !== true || typeof value.fingerprint !== "string") return Response.json({ error: "Explicit confirmation and preview fingerprint are required" }, { status: 400 });
  try { return Response.json({ task: publicTask(await reassociateManagedWorktree((await context.params).id, value.fingerprint)) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Reassociation failed" }, { status: 409 }); }
}
