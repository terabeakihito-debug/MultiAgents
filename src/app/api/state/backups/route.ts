import { stateBackupsService } from "@/core/state-backups-service";
import { createStateBackup } from "@/server/state-backup";
import { databaseReadiness } from "@/server/operational-health";
import { activeOperations, lifecycleState } from "@/server/operation-registry";
import { rejectNonLocalRequest, requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  return Response.json(stateBackupsService.load());
}

export async function POST(request: Request) {
  const rejection = requireHumanMutation(request, "state-backup", { label: "State backup" });
  if (rejection) return rejection;
  try {
    databaseReadiness();
    if (lifecycleState() !== "RUNNING") {
      return Response.json({ error: "Backups are unavailable while the server is draining" }, { status: 409 });
    }
    if (activeOperations().length) {
      return Response.json({ error: "Backups wait for active operations to finish" }, { status: 409 });
    }
    return Response.json({ backup: await createStateBackup() }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "State backup failed" },
      { status: 500 },
    );
  }
}
