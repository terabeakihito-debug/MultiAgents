export const humanMutationActions = [
  "agent-run", "review-run", "review-rerun", "task-create", "task-delete", "task-resume", "task-recover-pr",
  "task-prepare-approval", "task-approve", "task-approve-rework", "task-apply-review", "task-create-pr", "task-fetch-review", "task-refresh-pr",
  "profile-save", "template-save", "finding-extract", "finding-accept", "finding-dismiss", "finding-convert", "finding-priority", "finding-resolve",
  "notification-read", "notification-dismiss", "notification-read-all", "notification-preferences",
  "outbound-preferences", "outbound-test", "outbound-retry", "outbound-mark-delivered", "outbound-dismiss",
  "maintenance-mode", "state-backup", "state-backup-validate", "operations-provider-refresh", "operations-provider-acknowledge",
  "retention-policy", "cleanup-preview", "cleanup-execute",
  "task-reassociation-preview", "task-reassociation-confirm",
] as const;

export type HumanMutationAction = (typeof humanMutationActions)[number];
