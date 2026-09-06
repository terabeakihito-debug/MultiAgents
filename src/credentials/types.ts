export const credentialCapabilities = [
  "slack_outbound",
  "github_cli",
  "agent_codex",
  "agent_cursor",
  "agent_claude",
] as const;

export type CredentialCapability = (typeof credentialCapabilities)[number];
export type CredentialStatus = "configured" | "not_configured" | "externally_managed" | "unavailable";
export type CredentialSourceCategory = "environment" | "external_cli" | "os_store";

export type CredentialStatusView = {
  capability: CredentialCapability;
  status: CredentialStatus;
  source: CredentialSourceCategory;
};
