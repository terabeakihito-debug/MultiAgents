import { listProjectProfiles } from "@/server/project-profiles";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  return Response.json(listProjectProfiles());
}
