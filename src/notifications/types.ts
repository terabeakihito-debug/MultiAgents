export const notificationTypes = [
  "finding_critical_created",
  "finding_high_created",
  "task_needs_attention",
  "task_ready_for_approval",
  "pr_changes_requested",
  "ci_failed",
  "pr_ready_for_human_merge",
  "task_inactive",
  "worktree_orphaned",
  "approval_invalidated",
] as const;

export type NotificationType = (typeof notificationTypes)[number];
export const notificationSeverities = ["info", "warning", "high", "critical"] as const;
export type NotificationSeverity = (typeof notificationSeverities)[number];
export type NotificationStatus = "unread" | "read" | "dismissed";

export type AppNotification = {
  notificationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  repoId?: string;
  repoName?: string;
  taskId?: string;
  findingId?: string;
  prNumber?: number;
  title: string;
  message: string;
  status: NotificationStatus;
  dedupeKey: string;
  createdAt: string;
  readAt?: string;
  dismissedAt?: string;
};

export type NotificationPreferences = {
  criticalFindings: boolean;
  highFindings: boolean;
  needsAttention: boolean;
  readyForApproval: boolean;
  prChangesRequested: boolean;
  ciFailed: boolean;
  readyForHumanMerge: boolean;
  inactiveTask: boolean;
  worktreeOrphaned: boolean;
};

export const defaultNotificationPreferences: NotificationPreferences = {
  criticalFindings: true,
  highFindings: true,
  needsAttention: true,
  readyForApproval: true,
  prChangesRequested: true,
  ciFailed: true,
  readyForHumanMerge: true,
  inactiveTask: true,
  worktreeOrphaned: true,
};

export type NotificationQuery = {
  unreadOnly: boolean;
  severity?: NotificationSeverity;
  repoId?: string;
  type?: NotificationType;
  limit: number;
};
