import { repoPullsService, RepoPullsRequestError } from "@/core/repo-pulls-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    return Response.json(await repoPullsService.load((await context.params).id));
  } catch (error) {
    if (error instanceof RepoPullsRequestError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
