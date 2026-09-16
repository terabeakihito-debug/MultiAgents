import {
  repoTemplatesService,
  RepoTemplatesNotFoundError,
} from "@/core/repo-templates-service";
import { updateRepoTemplateSettings } from "@/server/task-templates";
import { rejectNonHumanTemplateMutation, rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    return Response.json(await repoTemplatesService.load((await context.params).id));
  } catch (error) {
    if (error instanceof RepoTemplatesNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanTemplateMutation(request);
  if (rejection) return rejection;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Task template settings input is invalid" }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set(["confirmation", "templateId", "enabled", "defaultTemplateId"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.confirmation !== true) {
    return Response.json(
      { error: "Explicit confirmation and only allowlisted task template fields are accepted" },
      { status: 400 },
    );
  }
  try {
    return Response.json(await updateRepoTemplateSettings((await context.params).id, {
      templateId: value.templateId as string | undefined,
      enabled: value.enabled as boolean | undefined,
      defaultTemplateId: value.defaultTemplateId as string | undefined,
    }));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Task template settings update failed" },
      { status: 400 },
    );
  }
}
