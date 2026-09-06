import { buildTaskRuntimePolicies, publicRuntimePolicy } from "@/server/runtime-policy";
import { getTask, initializeTaskRecovery, requireTaskTemplate } from "@/server/tasks";
import { rejectNonLocalRequest } from "@/server/request-security";
import { RUNTIME_POLICY_VERSION } from "@/runtime/types";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  await initializeTaskRecovery();
  const task = getTask((await context.params).id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  try {
    const template = requireTaskTemplate(task);
    const policies = await buildTaskRuntimePolicies(task);
    return Response.json({
      runtimePolicyVersion: RUNTIME_POLICY_VERSION,
      taskType: template.taskType,
      allAgentsReadOnly: template.readOnly,
      worktreeRequired: template.requireWorktree,
      networkEnforcementDescription: "Network access is CLI-managed; enforcement is not guaranteed by MultiAgents.",
      policies: Object.values(policies).map(publicRuntimePolicy),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Runtime policy is unavailable" }, { status: 409 });
  }
}
