import type { AgentId } from "../agents/types";

export type ProviderDiagnosticStatus =
  | "supported"
  | "supported_with_warning"
  | "version_probe_failed"
  | "unsupported_version"
  | "missing"
  | "credential_unavailable"
  | "sandbox_incompatible"
  | "flag_incompatible"
  | "launch_failed";

export type ProviderCredentialStatus = "available" | "missing" | "unsafe_permissions" | "unsupported_layout";

export type ProviderDiagnostic = {
  provider: AgentId;
  status: ProviderDiagnosticStatus;
  version?: string;
  previousVersion?: string;
  flagsCompatible: boolean;
  credentialStatus: ProviderCredentialStatus;
  sandboxCompatible: boolean;
  launchCompatible: boolean;
  checkedAt: string;
  versionChanged: boolean;
  identityChanged: boolean;
  acknowledgedVersion?: string;
  /** Secret-free execution fingerprint, present for live diagnostics. */
  identity?: string;
};

/** `identity` is a secret-free fingerprint of the exact host objects mounted into
 * the provider sandbox.  It is checked again immediately before launch. */
export type ProviderCompatibilitySnapshot = ProviderDiagnostic & { identity?: string };

export type WorktreeInventoryStatus =
  | "registered"
  | "orphaned_filesystem"
  | "missing_filesystem"
  | "unregistered_git_worktree";

export type WorktreeUsage = {
  taskId?: string;
  repoId: string;
  ageHours: number;
  sizeBytes: number;
  taskStatus?: string;
  dirty?: boolean;
  prState?: string;
  inventoryStatus: WorktreeInventoryStatus;
  cleanupCandidate: boolean;
};
