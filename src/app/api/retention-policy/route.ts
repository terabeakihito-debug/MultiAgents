import { retentionPresets, type RetentionPreset } from "@/operations/types";
import { requireHumanMutation, rejectNonLocalRequest } from "@/server/request-security";
import { getStateStore } from "@/server/state-store";
export const runtime = "nodejs";
export function GET(request: Request) { const rejection = rejectNonLocalRequest(request); if (rejection) return rejection; return Response.json({ preset: getStateStore().loadRetentionPolicy() }); }
export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "retention-policy", { label: "Retention policy" }); if (rejection) return rejection;
  let body: { preset?: unknown }; try { body = await request.json(); } catch { return Response.json({ error: "Retention policy must be valid JSON" }, { status: 400 }); }
  if (!retentionPresets.includes(body.preset as RetentionPreset)) return Response.json({ error: "Retention preset is invalid" }, { status: 400 });
  return Response.json({ preset: getStateStore().saveRetentionPolicy(body.preset as RetentionPreset) });
}
