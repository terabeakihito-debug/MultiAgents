import { listRepositories } from "@/server/repositories";
import { rejectNonLocalRequest } from "@/server/request-security";
import { getOrCreateRepoProfile } from "@/server/project-profiles";
import { getOrCreateRepoTemplates } from "@/server/task-templates";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  const repos = await listRepositories();
  return Response.json({ repos: await Promise.all(repos.map(async (repo) => {
    const [profile, templateData] = await Promise.all([getOrCreateRepoProfile(repo.id), getOrCreateRepoTemplates(repo.id)]);
    return { ...repo, profile, ...templateData };
  })) });
}
