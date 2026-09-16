import {
  dependencyRecoveryService,
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
} from "../../../../../core/dependency-recovery-service";
import { requireHumanMutation } from "@/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(
    request,
    "task-dependency-recovery-instructions",
    { label: "Dependency recovery instructions" },
  );
  if (rejection) return rejection;

  try {
    const instructions = await dependencyRecoveryService.load((await context.params).id);
    return Response.json(instructions, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DependencyRecoveryTaskNotFoundError) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }
    if (error instanceof DependencyRecoveryUnavailableError) {
      return Response.json(
        { error: "Dependency recovery instructions are unavailable for this task" },
        { status: 409 },
      );
    }
    throw error;
  }
}
