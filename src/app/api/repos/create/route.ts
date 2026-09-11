import { createLocalProject } from "@/server/repositories";
import { rejectNonHumanRepositoryMutation } from "@/server/request-security";
import { getOrCreateRepoProfile } from "@/server/project-profiles";
import { getOrCreateRepoTemplates } from "@/server/task-templates";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejection = rejectNonHumanRepositoryMutation(request, "repository-create");
  if (rejection) return rejection;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["projectName", "createReadme"].includes(key)) || typeof (body as { projectName?: unknown }).projectName !== "string" || ((body as { createReadme?: unknown }).createReadme !== undefined && typeof (body as { createReadme?: unknown }).createReadme !== "boolean")) return Response.json({ error: "Project name or options are invalid" }, { status: 400 });
  try {
    const repo = await createLocalProject((body as { projectName: string }).projectName, (body as { createReadme?: boolean }).createReadme === true);
    const [profile, templateData] = await Promise.all([getOrCreateRepoProfile(repo.id), getOrCreateRepoTemplates(repo.id)]);
    return Response.json({ repo: { ...repo, profile, ...templateData }, needsInitialCommit: true }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not create the project" }, { status: 400 }); }
}
