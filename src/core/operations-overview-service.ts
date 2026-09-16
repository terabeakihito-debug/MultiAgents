import { operationsOverview } from "../server/operational-health";

type OperationsOverviewDependencies = {
  load: typeof operationsOverview;
};

export function createOperationsOverviewService(dependencies: OperationsOverviewDependencies = {
  load: operationsOverview,
}) {
  return {
    load() {
      return dependencies.load();
    },
  };
}

/** Framework-independent operations overview read boundary used by transport adapters. */
export const operationsOverviewService = createOperationsOverviewService();
