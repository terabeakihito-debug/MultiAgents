export const taskBuckets = [
  "active",
  "needs_attention",
  "ready_for_approval",
  "pr_open",
  "ready_for_human_merge",
  "archived",
] as const;

export type TaskBucket = (typeof taskBuckets)[number];

export const nextActions = [
  "resume_flow",
  "review_diff",
  "revalidate",
  "relogin_github",
  "fetch_pr_review",
  "apply_reviewed_fixes",
  "review_rework_diff",
  "open_pr",
  "human_merge",
  "manual_recovery",
  "cleanup",
] as const;

export type NextAction = (typeof nextActions)[number];
export type DashboardSort = "updated_desc" | "created_desc" | "repo_name";
export type PrFilter = "any" | "with_pr" | "without_pr";

export type DashboardTask = {
  id: string;
  repoId: string;
  repoName: string;
  summary: string;
  status: string;
  bucket: TaskBucket;
  branch: string;
  baseBranch: string;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  createdAt: string;
  updatedAt: string;
  inactive: boolean;
  recoveryStatus: string;
  recoveryMessage?: string;
  worktreeStatus: string;
  profileName: string;
  profileVersion: number;
  nextAction: NextAction;
  nextActionLabel: string;
  attentionReason?: string;
  canResume: boolean;
  canViewDiff: boolean;
  canRefreshPr: boolean;
  cleanup: {
    allowed: boolean;
    requiresConfirmation: boolean;
    warning?: string;
    blockedReason?: string;
  };
};

export type DashboardCounts = Record<TaskBucket, number>;

export type DashboardResponse = {
  tasks: DashboardTask[];
  counts: DashboardCounts;
  limit: number;
};
