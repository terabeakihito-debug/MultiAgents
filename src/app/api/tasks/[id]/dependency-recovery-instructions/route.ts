import { dependencyRecoveryInstructions } from "../../../../../server/dependency-recovery";
import { requireHumanMutation } from "@/server/request-security";
import { getTask, initializeTaskRecovery } from "@/server/tasks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = requireHumanMutation(request, "task-dependency-recovery-instructions", { label: "Dependency recovery instructions" });
  if (rejection) return rejection;

  await initializeTaskRecovery();
  const task = getTask((await context.params).id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });

  const instructions = dependencyRecoveryInstructions(task);
  if (!instructions) return Response.json({ error: "Dependency recovery instructions are unavailable for this task" }, { status: 409 });
  return Response.json(instructions, { headers: { "Cache-Control": "no-store" } });
}
