import { getOrCreateRepoProfile, updateRepoProfile } from "@/server/project-profiles";
import { rejectNonHumanProfileMutation, rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try { return Response.json({ profile: await getOrCreateRepoProfile((await context.params).id) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Profile lookup failed" }, { status: 404 }); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonHumanProfileMutation(request);
  if (rejection) return rejection;
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Request body must be valid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Profile input is invalid" }, { status: 400 });
  const value = body as Record<string, unknown>;
  const allowed = new Set(["confirmation", "name", "enabled", "roles", "validation"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.confirmation !== true) {
    return Response.json({ error: "Explicit confirmation and only allowlisted profile fields are accepted" }, { status: 400 });
  }
  try {
    const profile = await updateRepoProfile((await context.params).id, {
      name: value.name as string,
      enabled: value.enabled as boolean,
      roles: value.roles,
      validation: value.validation,
    });
    return Response.json({ profile });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Profile update failed" }, { status: 400 });
  }
}
