export const findingSeverities = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof findingSeverities)[number];

export const findingStatuses = ["open", "accepted", "dismissed", "converted"] as const;
export type FindingStatus = (typeof findingStatuses)[number];

export const humanPriorities = ["urgent", "high", "normal", "low"] as const;
export type HumanPriority = (typeof humanPriorities)[number];

export const remediationStages = [
  "untriaged",
  "accepted",
  "implementation_not_created",
  "implementation_active",
  "awaiting_approval",
  "pr_open",
  "ready_for_human_merge",
  "resolved_candidate",
  "resolved",
  "dismissed",
  "needs_attention",
] as const;
export type RemediationStage = (typeof remediationStages)[number];

export const findingNextActions = [
  "review_finding",
  "accept_or_dismiss",
  "create_implementation_task",
  "resume_implementation",
  "review_diff",
  "open_pr",
  "fetch_pr_review",
  "human_merge",
  "mark_resolved",
  "manual_recovery",
  "none",
] as const;
export type FindingNextAction = (typeof findingNextActions)[number];

export type Finding = {
  findingId: string;
  sourceTaskId: string;
  title: string;
  summary: string;
  severity: FindingSeverity;
  category?: string;
  affectedPaths?: string[];
  evidence?: string;
  status: FindingStatus;
  humanPriority: HumanPriority;
  createdAt: string;
  updatedAt: string;
  convertedTaskId?: string;
  resolvedAt?: string;
  resolvedBy?: "user";
};

export const findingEventTypes = [
  "finding_created",
  "finding_accepted",
  "finding_dismissed",
  "finding_conversion_requested",
  "implementation_task_created",
  "finding_priority_changed",
  "finding_resolved",
] as const;
export type FindingEventType = (typeof findingEventTypes)[number];
export type FindingEvent = {
  id: string;
  sequence: number;
  findingId: string;
  sourceTaskId: string;
  type: FindingEventType;
  actor: "user" | "system";
  createdAt: string;
  reason?: string;
  convertedTaskId?: string;
  previousHumanPriority?: HumanPriority;
  humanPriority?: HumanPriority;
};

export type RemediationQueueSort = "recommended" | "severity" | "age" | "updated" | "repo";
export type RemediationPresenceFilter = "any" | "yes" | "no";
export type RemediationQueueItem = {
  findingId: string;
  title: string;
  category?: string;
  affectedPaths?: string[];
  severity: FindingSeverity;
  humanPriority: HumanPriority;
  repoId: string;
  repoName: string;
  sourceTaskId: string;
  sourceTemplateName?: string;
  sourceTemplateVersion?: number;
  findingStatus: FindingStatus;
  remediationStage: RemediationStage;
  implementationTaskId?: string;
  implementationTaskStatus?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  mergeReadiness?: string;
  createdAt: string;
  updatedAt: string;
  ageMs: number;
  nextAction: FindingNextAction;
  attentionReason?: string;
  resolvedAt?: string;
  resolvedBy?: "user";
};

export type RemediationQueueCounts = {
  total: number;
  critical: number;
  high: number;
  acceptedNotConverted: number;
  needsAttention: number;
  readyForMerge: number;
};

export type RemediationQueueResponse = {
  findings: RemediationQueueItem[];
  counts: RemediationQueueCounts;
  limit: number;
  offset: number;
};

export type FindingCandidate = Pick<Finding, "title" | "summary" | "severity" | "category" | "affectedPaths" | "evidence">;
