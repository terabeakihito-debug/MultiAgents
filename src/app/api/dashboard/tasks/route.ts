import { DashboardQueryError, getDashboard, parseDashboardQuery } from "@/server/dashboard";
import { rejectNonLocalRequest } from "@/server/request-security";
import { initializeTaskRecovery } from "@/server/tasks";
import { evaluateInactiveTasks } from "@/server/notifications";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    const query = parseDashboardQuery(new URL(request.url));
    evaluateInactiveTasks();
    await initializeTaskRecovery();
    return Response.json(await getDashboard(query));
  } catch (error) {
    const status = error instanceof DashboardQueryError ? 400 : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Dashboard request failed" }, { status });
  }
}
