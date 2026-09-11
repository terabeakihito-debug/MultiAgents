import { initializeLocalProject } from "@/server/repositories";
import { rejectNonHumanRepositoryMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanRepositoryMutation(request, "repository-initialize");
  if (rejection) return rejection;
  try { return Response.json({ repo: await initializeLocalProject((await context.params).id) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not initialize the project" }, { status: 400 }); }
}
