export const operationTypes = [
  "worktree_create",
  "finding_conversion",
  "git_commit",
  "git_push",
  "pr_create",
  "slack_delivery",
  "cleanup_worktree",
  "cleanup_node_modules",
  "cleanup_backup",
  "cleanup_notifications",
] as const;

export type OperationType = (typeof operationTypes)[number];

export const operationStates = [
  "prepared",
  "executing",
  "external_succeeded",
  "persisted",
  "reconcile_required",
  "failed",
] as const;

export type OperationState = (typeof operationStates)[number];
export type SafeOperationMetadata = Record<string, string | number | boolean | undefined>;

export type DurableOperation = {
  operationId: string;
  type: OperationType;
  taskId?: string;
  findingId?: string;
  notificationId?: string;
  idempotencyKey: string;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  safeMetadata: SafeOperationMetadata;
  errorCode?: string;
};

export type BackupMetadata = {
  backupId: string;
  createdAt: string;
  schemaVersion: number;
  integrityStatus: "ok";
  sizeBytes: number;
  appCommit?: string;
};

export const retentionPresets = ["conservative", "balanced"] as const;
export type RetentionPreset = (typeof retentionPresets)[number];
export const cleanupCandidateTypes = ["worktree", "worktree_node_modules", "backup", "notification", "outbound_delivery"] as const;
export type CleanupCandidateType = (typeof cleanupCandidateTypes)[number];
export type CleanupCandidate = { candidateId: string; type: CleanupCandidateType; repoId?: string; taskId?: string; ageDays: number; estimatedBytes: number; safeToDelete: boolean; blockedReasons: string[]; recommendedAction: "delete" | "review" | "keep" };
