import type { CredentialCapability, CredentialStatusView } from "../credentials/types";
import { credentialResolver, type CredentialResolver } from "./credential-resolver";
import { getStateStore } from "./state-store";

export function credentialStatusView(
  resolver: CredentialResolver = credentialResolver,
  options: { audit?: boolean } = {},
): { credentials: CredentialStatusView[] } {
  const credentials = resolver.statuses();
  if (options.audit) {
    const store = getStateStore();
    for (const item of credentials) store.appendCredentialAudit("credential_status_checked", item.capability, item.status);
  }
  return { credentials };
}

export function auditCredentialResolutionFailure(capability: CredentialCapability, resolver: CredentialResolver = credentialResolver) {
  const status = resolver.status(capability).status;
  getStateStore().appendCredentialAudit("credential_resolution_failed", capability, status);
}
