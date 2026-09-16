import { describe, expect, it, vi } from "vitest";
import {
  createDashboardTasksService,
  DashboardQueryError,
} from "./dashboard-tasks-service";

describe("dashboard tasks service", () => {
  it("parses the URL, evaluates inactive tasks, initializes recovery, and loads the dashboard", async () => {
    const calls: string[] = [];
    const query = { limit: 50, sort: "updated_desc" as const };
    const payload = { tasks: [{ id: "task-1" }], counts: {} };
    const parseQuery = vi.fn(() => {
      calls.push("parse");
      return query;
    });
    const evaluateInactiveTasks = vi.fn(() => {
      calls.push("evaluate");
    });
    const initializeRecovery = vi.fn(async () => {
      calls.push("recovery");
    });
    const loadDashboard = vi.fn(async () => {
      calls.push("dashboard");
      return payload;
    });
    const service = createDashboardTasksService({
      parseQuery,
      evaluateInactiveTasks,
      initializeRecovery,
      loadDashboard,
    } as unknown as Parameters<typeof createDashboardTasksService>[0]);
    const url = new URL("http://127.0.0.1/dashboard/tasks?limit=50");

    await expect(service.load(url)).resolves.toEqual(payload);
    expect(calls).toEqual(["parse", "evaluate", "recovery", "dashboard"]);
    expect(parseQuery).toHaveBeenCalledWith(url);
    expect(loadDashboard).toHaveBeenCalledWith(query);
  });

  it("propagates invalid query errors before side effects", async () => {
    const evaluateInactiveTasks = vi.fn();
    const initializeRecovery = vi.fn();
    const loadDashboard = vi.fn();
    const parseQuery = vi.fn(() => {
      throw new DashboardQueryError("Invalid bucket");
    });
    const service = createDashboardTasksService({
      parseQuery,
      evaluateInactiveTasks,
      initializeRecovery,
      loadDashboard,
    } as unknown as Parameters<typeof createDashboardTasksService>[0]);

    await expect(service.load(new URL("http://127.0.0.1/dashboard/tasks?bucket=bad"))).rejects.toBeInstanceOf(
      DashboardQueryError,
    );
    expect(evaluateInactiveTasks).not.toHaveBeenCalled();
    expect(initializeRecovery).not.toHaveBeenCalled();
    expect(loadDashboard).not.toHaveBeenCalled();
  });
});
