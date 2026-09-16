import {
  BackupValidationError,
  stateBackupValidateService,
} from "@/core/state-backup-validate-service";
import { requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "state-backup-validate", { label: "Backup validation" }); if (rejection) return rejection;
  try {
    return Response.json(stateBackupValidateService.load((await context.params).id));
  }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Backup validation failed" }, { status: error instanceof BackupValidationError ? 400 : 500 }); }
}
