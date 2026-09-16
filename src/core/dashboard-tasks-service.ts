import {
  DashboardQueryError,
  getDashboard,
  parseDashboardQuery,
} from "../server/dashboard";
import { evaluateInactiveTasks } from "../server/notifications";
import { initializeTaskRecovery } from "../server/tasks";

type DashboardTasksDependencies = {
  parseQuery: typeof parseDashboardQuery;
  evaluateInactiveTasks: typeof evaluateInactiveTasks;
  initializeRecovery: typeof initializeTaskRecovery;
  loadDashboard: typeof getDashboard;
};

export function createDashboardTasksService(dependencies: DashboardTasksDependencies = {
  parseQuery: parseDashboardQuery,
  evaluateInactiveTasks,
  initializeRecovery: initializeTaskRecovery,
  loadDashboard: getDashboard,
}) {
  return {
    async load(url: URL) {
      const query = dependencies.parseQuery(url);
      dependencies.evaluateInactiveTasks();
      await dependencies.initializeRecovery();
      return dependencies.loadDashboard(query);
    },
  };
}

/** Framework-independent dashboard tasks read boundary used by transport adapters. */
export const dashboardTasksService = createDashboardTasksService();

export { DashboardQueryError };
