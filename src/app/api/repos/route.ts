import { listRepositories } from "@/server/repositories";
import { rejectNonLocalRequest } from "@/server/request-security";
import { getOrCreateRepoProfile } from "@/server/project-profiles";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  const repos = await listRepositories();
  return Response.json({ repos: await Promise.all(repos.map(async (repo) => ({ ...repo, profile: await getOrCreateRepoProfile(repo.id) }))) });
}
