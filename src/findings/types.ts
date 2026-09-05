export const findingSeverities = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof findingSeverities)[number];

export const findingStatuses = ["open", "accepted", "dismissed", "converted"] as const;
export type FindingStatus = (typeof findingStatuses)[number];

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
  createdAt: string;
  updatedAt: string;
  convertedTaskId?: string;
};

export const findingEventTypes = [
  "finding_created",
  "finding_accepted",
  "finding_dismissed",
  "finding_conversion_requested",
  "implementation_task_created",
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
};

export type FindingCandidate = Pick<Finding, "title" | "summary" | "severity" | "category" | "affectedPaths" | "evidence">;
