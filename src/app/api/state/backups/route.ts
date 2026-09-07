import { createStateBackup, latestVerifiedBackup } from "@/server/state-backup";
import { rejectNonLocalRequest, requireHumanMutation } from "@/server/request-security";
import { getStateStore } from "@/server/state-store";

export const runtime = "nodejs";

export function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  return Response.json({ backups: getStateStore().loadBackups(), latest: latestVerifiedBackup() });
}

export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "state-backup", { label: "State backup" }); if (rejection) return rejection;
  try { return Response.json({ backup: await createStateBackup() }, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "State backup failed" }, { status: 500 }); }
}
