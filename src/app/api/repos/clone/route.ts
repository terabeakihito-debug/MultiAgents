import { cloneGitHubProject } from "@/server/repositories";
import { rejectNonHumanRepositoryMutation } from "@/server/request-security";
import { getOrCreateRepoProfile } from "@/server/project-profiles";
import { getOrCreateRepoTemplates } from "@/server/task-templates";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = rejectNonHumanRepositoryMutation(request, "repository-clone");
  if (rejection) return rejection;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { githubUrl?: unknown }).githubUrl !== "string") return Response.json({ error: "A GitHub repository URL is required" }, { status: 400 });
  try {
    const repo = await cloneGitHubProject((body as { githubUrl: string }).githubUrl);
    const [profile, templateData] = await Promise.all([getOrCreateRepoProfile(repo.id), getOrCreateRepoTemplates(repo.id)]);
    return Response.json({ repo: { ...repo, profile, ...templateData } }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not add the GitHub project" }, { status: 400 }); }
}
