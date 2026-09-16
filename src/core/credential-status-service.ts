import { credentialStatusView } from "../server/credential-status";

type CredentialStatusDependencies = {
  loadView: typeof credentialStatusView;
};

export function createCredentialStatusService(dependencies: CredentialStatusDependencies = {
  loadView: credentialStatusView,
}) {
  return {
    load() {
      return dependencies.loadView(undefined, { audit: true });
    },
  };
}

/** Framework-independent credential status read boundary used by transport adapters. */
export const credentialStatusService = createCredentialStatusService();
