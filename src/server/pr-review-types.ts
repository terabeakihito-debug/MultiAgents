export type ReviewDisposition = "informational" | "action_required" | "blocking" | "resolved";

export type PullRequestCheck = {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "unknown";
  required: boolean;
  workflow?: string;
  link?: string;
};

export type PullRequestReviewItem = {
  id: string;
  kind: "review" | "comment" | "thread" | "check";
  author: string;
  body: string;
  state?: string;
  path?: string;
  line?: number;
  url?: string;
  resolved?: boolean;
  disposition: ReviewDisposition;
  reason: string;
  potentiallyAddressed?: boolean;
};

export type PullRequestReview = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  merged: boolean;
  base: string;
  head: string;
  headSha: string;
  mergeable: string;
  mergeStateStatus: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
  checks: PullRequestCheck[];
  items: PullRequestReviewItem[];
  reviewCount: number;
  unresolvedCount: number;
  fetchedAt: string;
};

export type PrReviewStepId = "codex_triage" | "cursor_validation" | "claude_validation" | "codex_rework_plan";
export type PrReviewStep = {
  id: PrReviewStepId;
  agent: "codex" | "cursor" | "claude";
  status: "completed" | "error" | "skipped";
  output: string;
  error?: string;
};

export type PrReviewIntake = {
  status: "completed" | "error";
  steps: PrReviewStep[];
  requiresRework: boolean;
  readyForHumanMerge: boolean;
};

export type ReworkFlowResult = {
  status: "completed" | "error" | "aborted" | "timed_out";
  steps: Array<{
    id: "codex_rework" | "cursor_rework_review" | "claude_rework_review" | "codex_final_fix";
    agent: "codex" | "cursor" | "claude";
    status: "completed" | "error" | "skipped";
    output: string;
    error?: string;
  }>;
};
