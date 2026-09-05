import { initializeTaskRecovery, listTasks, publicTask } from "@/server/tasks";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request); if (rejection) return rejection;
  await initializeTaskRecovery();
  return Response.json({ tasks: listTasks().map(publicTask) });
}
