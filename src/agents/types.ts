export const agentIds = ["codex", "cursor", "claude"] as const;

export type AgentId = (typeof agentIds)[number];
export type AgentStatus = "idle" | "running" | "completed" | "error";

/** Content-free lifecycle facts for a spawned provider process. */
export type AgentLifecycleTelemetry = {
  spawnedAt: string;
  timeoutRequestedAt?: string;
  sigtermRequestedAt?: string;
  sigtermSentAt?: string;
  sigkillRequestedAt?: string;
  sigkillSentAt?: string;
  childClosedAt?: string;
  exitCode?: number;
  exitSignal?: NodeJS.Signals;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutFirstByteAt?: string;
  stdoutLastByteAt?: string;
  stderrFirstByteAt?: string;
  stderrLastByteAt?: string;
  terminationMethod?: "term_only" | "kill_required";
  terminationReason?: AgentTerminationReason;
};

export type AgentTerminationReason = "agent_deadline_exceeded" | "request_aborted" | "flow_aborted" | "step_budget_exhausted";

export type AgentResult = {
  agent: AgentId;
  status: "completed" | "error";
  output: string;
  error?: string;
  runtimeViolation?: import("../runtime/types").RuntimeViolation;
  /** Caller settled before process death could be confirmed; admission remains quarantined. */
  finalizationUnconfirmed?: true;
  /** Durable ownership write failed; this server remains quarantined but restart safety is not established. */
  finalizationPersistenceFailed?: true;
  terminationReason?: AgentTerminationReason;
  lifecycleTelemetry?: AgentLifecycleTelemetry;
};

export type AgentDefinition = {
  id: AgentId;
  name: string;
  binary: string;
  args: (prompt: string, cwd: string, repositoryTask: boolean, writeAccess: boolean) => string[];
};

export type AgentRunOptions = {
  signal?: AbortSignal;
  policy?: import("../runtime/types").RuntimePolicy;
  onSandboxAudit?: (event: import("../server/os-sandbox").OsSandboxAudit) => unknown;
  /** Runs after child close/unregister while the active-agent gate is held. */
  afterClose?: (result: AgentResult) => Promise<AgentResult> | AgentResult;
  /** Receives content-free process lifecycle facts after child close. */
  onLifecycleTelemetry?: (telemetry: AgentLifecycleTelemetry) => unknown;
};

export type AgentAdapter = {
  id: AgentId;
  name: string;
  /** True only when this adapter executes AgentRunOptions.afterClose itself. */
  supportsPostCloseFinalization?: true;
  run: (prompt: string, options?: AgentRunOptions) => Promise<AgentResult>;
};

export const flowStepIds = ["codex_draft", "cursor_review", "claude_review", "codex_final"] as const;
export type FlowStepId = (typeof flowStepIds)[number];
export type FlowStepStatus = AgentStatus | "skipped" | "stale";
export type FlowRole = "draft" | "review" | "final";

export type FlowStep = {
  id: FlowStepId;
  agent: AgentId;
  role: FlowRole;
  status: FlowStepStatus;
  inputSummary?: string;
  output: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  runtimeViolation?: import("../runtime/types").RuntimeViolation;
  terminationReason?: AgentTerminationReason;
};

export type ReviewFlowResult = {
  flowId: string;
  status: "completed" | "error" | "aborted" | "timed_out";
  steps: FlowStep[];
  finalOutput: string;
};

export const rerunnableStepIds = ["cursor_review", "claude_review", "codex_final"] as const;
export type RerunnableStepId = (typeof rerunnableStepIds)[number];

export type ReviewRerunResult = {
  flowId: string;
  rerunId: string;
  stepId: RerunnableStepId;
  status: "completed" | "error" | "aborted" | "timed_out";
  steps: FlowStep[];
  finalOutput: string;
};

export type FlowEvent =
  | { type: "flow_started"; flowId: string; timestamp: string }
  | { type: "step_started" | "step_completed" | "step_error" | "step_skipped"; flowId: string; step: FlowStep }
  | { type: "flow_completed" | "flow_aborted" | "flow_timed_out"; flowId: string; result: ReviewFlowResult };

export type ReviewRerunEvent =
  | { type: "rerun_started"; flowId: string; rerunId: string; stepId: RerunnableStepId; timestamp: string }
  | { type: "rerun_step_started" | "rerun_step_completed" | "rerun_step_error"; flowId: string; rerunId: string; step: FlowStep }
  | { type: "rerun_completed" | "rerun_aborted" | "rerun_timed_out"; flowId: string; rerunId: string; result: ReviewRerunResult };

export type StreamEvent = FlowEvent | ReviewRerunEvent;
