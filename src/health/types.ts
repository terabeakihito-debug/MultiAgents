import type { AgentId } from "../agents/types";

export type ProviderDiagnosticStatus =
  | "supported"
  | "unsupported_version"
  | "missing"
  | "credential_unavailable"
  | "sandbox_incompatible";

export type ProviderDiagnostic = {
  provider: AgentId;
  status: ProviderDiagnosticStatus;
  version?: string;
};

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
