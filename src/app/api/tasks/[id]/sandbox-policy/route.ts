import { buildTaskRuntimePolicies } from "@/server/runtime-policy";
import { publicOsSandboxPolicy } from "@/server/os-sandbox";
import { getTask, initializeTaskRecovery } from "@/server/tasks";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  await initializeTaskRecovery();
  const task = getTask((await context.params).id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  try {
    const policies = await buildTaskRuntimePolicies(task);
    return Response.json({
      status: "enforced",
      validation: publicOsSandboxPolicy("validation"),
      agents: Object.values(policies).filter((policy) => policy.role !== "disabled").map((policy) => ({
        agent: policy.agent,
        ...publicOsSandboxPolicy(policy.osSandboxProfile),
      })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OS sandbox policy is unavailable" }, { status: 409 });
  }
}
