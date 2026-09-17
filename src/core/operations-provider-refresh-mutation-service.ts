import { providerDiagnostics } from "../server/provider-diagnostics";

type OperationsProviderRefreshMutationDependencies = {
  refresh: typeof providerDiagnostics;
};

export function createOperationsProviderRefreshMutationService(
  dependencies: OperationsProviderRefreshMutationDependencies = {
    refresh: (options) => providerDiagnostics(options),
  },
) {
  return {
    async apply() {
      const providers = await dependencies.refresh({ force: true });
      return { providers };
    },
  };
}

/** Framework-independent operations provider refresh mutation used by transport adapters. */
export const operationsProviderRefreshMutationService =
  createOperationsProviderRefreshMutationService();
