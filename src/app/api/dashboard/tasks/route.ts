import {
  dashboardTasksService,
  DashboardQueryError,
} from "@/core/dashboard-tasks-service";
import { rejectNonLocalRequest } from "@/server/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rejection = rejectNonLocalRequest(request);
  if (rejection) return rejection;
  try {
    return Response.json(await dashboardTasksService.load(new URL(request.url)));
  } catch (error) {
    const status = error instanceof DashboardQueryError ? 400 : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "Dashboard request failed" },
      { status },
    );
  }
}
