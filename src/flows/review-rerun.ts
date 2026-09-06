import { randomUUID } from "node:crypto";
import { agents as defaultAgents } from "../agents";
import { flowStepIds, rerunnableStepIds, type AgentAdapter, type AgentId, type FlowStep, type RerunnableStepId, type ReviewRerunEvent, type ReviewRerunResult } from "../agents/types";
import { MAX_FLOW_MS, claudePrompt, cursorPrompt, finalPrompt } from "./review";
import { createEventStream } from "./event-stream";
import type { RolePolicy } from "../profiles/policy";
import type { RuntimePolicy } from "../runtime/types";
import { buildGenericRuntimePolicy } from "../server/runtime-policy";

export const MAX_STEP_OUTPUT_CHARS = 1_000_000;
type AgentSet = Record<AgentId, AgentAdapter>;
type RerunLogEntry = { flowId: string; rerunId: string; stepId: RerunnableStepId; agent: AgentId; status: FlowStep["status"]; durationMs?: number };
type RerunOptions = {
  signal?: AbortSignal;
  agents?: AgentSet;
  maxRerunMs?: number;
  now?: () => number;
  rerunId?: string;
  log?: (entry: RerunLogEntry) => void;
  onEvent?: (event: ReviewRerunEvent) => void;
  cwd?: string;
  roles?: RolePolicy;
  fingerprint?: () => Promise<string>;
  runtimePolicies?: Record<AgentId, RuntimePolicy>;
  executeAgent?: (agent: AgentId, prompt: string, signal: AbortSignal, stepId: RerunnableStepId) => Promise<import("../agents/types").AgentResult>;
};

export type ReviewRerunRequest = { prompt: string; flowId: string; stepId: RerunnableStepId; steps: FlowStep[] };
export type ReviewRerunCommand = { taskId: string; stepId: RerunnableStepId };

export function parseReviewRerunCommand(body: unknown): ReviewRerunCommand | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body must be an object" };
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["taskId", "stepId"].includes(key))) return { error: "Rerun accepts only taskId and stepId" };
  if (typeof value.taskId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.taskId)) return { error: "A valid taskId is required" };
  if (typeof value.stepId !== "string" || !rerunnableStepIds.includes(value.stepId as RerunnableStepId)) return { error: "Invalid rerun stepId" };
  return { taskId: value.taskId, stepId: value.stepId as RerunnableStepId };
}

export function reconstructReviewRerunRequest(
  persisted: { prompt?: string; flowId?: string; flowSteps?: FlowStep[] },
  stepId: RerunnableStepId,
): ReviewRerunRequest | { error: string } {
  if (typeof persisted.prompt !== "string" || !persisted.prompt.trim() || persisted.prompt.length > 20_000) return { error: "Persisted task prompt is unavailable" };
  if (typeof persisted.flowId !== "string" || !persisted.flowId.trim() || persisted.flowId.length > 200) return { error: "Persisted flow is unavailable" };
  if (!Array.isArray(persisted.flowSteps) || persisted.flowSteps.length !== flowStepIds.length) return { error: "Persisted flow must contain exactly four steps" };
  const steps: FlowStep[] = [];
  for (let index = 0; index < flowStepIds.length; index += 1) {
    const raw = persisted.flowSteps[index];
    if (!raw || typeof raw !== "object") return { error: "Invalid flow step data" };
    const item = raw as Record<string, unknown>;
    if (item.id !== flowStepIds[index] || typeof item.output !== "string") return { error: "Persisted flow steps do not use the fixed review order" };
    if (item.output.length > MAX_STEP_OUTPUT_CHARS) return { error: `Step output must be ${MAX_STEP_OUTPUT_CHARS} characters or fewer` };
    const source = item as unknown as FlowStep;
    const canonical = canonicalStep(source.id);
    steps.push({ ...source, ...canonical, output: item.output });
  }
  const missing = requiredUpstream(stepId).find((id) => {
    const step = steps.find((item) => item.id === id)!;
    return !step.output || !["completed", "stale"].includes(step.status);
  });
  if (missing) return { error: `Missing usable upstream data: ${missing}` };
  return { prompt: persisted.prompt, flowId: persisted.flowId, stepId, steps };
}

export async function rerunReviewStep(request: ReviewRerunRequest, options: RerunOptions = {}): Promise<ReviewRerunResult> {
  const adapters = options.agents ?? defaultAgents;
  const now = options.now ?? Date.now;
  const rerunId = options.rerunId ?? randomUUID();
  const steps = request.steps.map((step) => ({ ...step }));
  const target = steps.find((step) => step.id === request.stepId)!;
  const previousOutput = target.output;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error("Review step rerun timed out")); }, options.maxRerunMs ?? MAX_FLOW_MS);
  timeout.unref();

  try {
    emit(options.onEvent, { type: "rerun_started", flowId: request.flowId, rerunId, stepId: request.stepId, timestamp: new Date(now()).toISOString() });
    const start = now();
    target.status = "running";
    target.error = undefined;
    target.startedAt = new Date(start).toISOString();
    target.completedAt = undefined;
    target.durationMs = undefined;
    const input = buildRerunPrompt(request.prompt, request.stepId, steps);
    target.inputSummary = `${input.length.toLocaleString("en-US")} characters`;
    options.log?.({ flowId: request.flowId, rerunId, stepId: request.stepId, agent: target.agent, status: "running" });
    emit(options.onEvent, { type: "rerun_step_started", flowId: request.flowId, rerunId, step: { ...target } });
    const policy = options.runtimePolicies?.[target.agent] ?? buildGenericRuntimePolicy(target.agent);
    const configuredRole = policy.role;
    if (configuredRole === "disabled") {
      target.status = "skipped";
      target.output = previousOutput;
      target.error = `${target.agent} is disabled by the task profile`;
    }
    try {
      const result = configuredRole === "disabled" ? undefined : options.executeAgent
        ? await options.executeAgent(target.agent, input, controller.signal, request.stepId)
        : await adapters[target.agent].run(input, { signal: controller.signal, policy });
      if (!result) {
        // Disabled roles are never executed.
      } else if (result.status === "completed") {
        target.status = "completed";
        target.output = result.output;
        target.error = undefined;
      } else {
        target.status = "error";
        target.output = previousOutput;
        target.error = `Re-run failed: ${result.error ?? "Agent execution failed"}`;
        target.runtimeViolation = result.runtimeViolation;
      }
    } catch (error) {
      target.status = "error";
      target.output = previousOutput;
      target.error = `Re-run failed: ${error instanceof Error ? error.message : "Agent execution failed"}`;
    }
    const end = now();
    target.completedAt = new Date(end).toISOString();
    target.durationMs = Math.max(0, end - start);
    options.log?.({ flowId: request.flowId, rerunId, stepId: request.stepId, agent: target.agent, status: target.status, durationMs: target.durationMs });
    emit(options.onEvent, { type: target.status === "completed" ? "rerun_step_completed" : "rerun_step_error", flowId: request.flowId, rerunId, step: { ...target } });
    if (target.status === "completed") markDownstreamStale(steps, request.stepId);
    const status = timedOut ? "timed_out" : controller.signal.aborted ? "aborted" : target.status === "completed" ? "completed" : "error";
    const result: ReviewRerunResult = { flowId: request.flowId, rerunId, stepId: request.stepId, status, steps, finalOutput: steps[3].output };
    emit(options.onEvent, { type: status === "timed_out" ? "rerun_timed_out" : status === "aborted" ? "rerun_aborted" : "rerun_completed", flowId: request.flowId, rerunId, result });
    return result;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromRequest);
  }
}

export function createReviewRerunStream(request: ReviewRerunRequest, requestSignal: AbortSignal, runner = rerunReviewStep, options: { cwd?: string; roles?: RolePolicy; fingerprint?: () => Promise<string>; runtimePolicies?: Record<AgentId, RuntimePolicy>; executeAgent?: RerunOptions["executeAgent"]; onComplete?: (result: ReviewRerunResult) => void; onEvent?: (event: ReviewRerunEvent) => void } = {}) {
  const { onComplete, onEvent, ...runnerOptions } = options;
  return createEventStream(requestSignal, async ({ signal, send }) => {
    const result = await runner(request, {
    signal,
    onEvent: (event) => { onEvent?.(event); send(event); },
    log: (entry) => console.info("review_rerun", JSON.stringify(entry)),
    ...runnerOptions,
    });
    onComplete?.(result);
    return result;
  }, "review_rerun_event");
}

function buildRerunPrompt(prompt: string, stepId: RerunnableStepId, steps: FlowStep[]) {
  const draft = steps[0].output;
  if (stepId === "cursor_review") return cursorPrompt(prompt, draft);
  if (stepId === "claude_review") return claudePrompt(prompt, draft, steps[1]);
  return finalPrompt(prompt, draft, steps[1], steps[2]);
}

function markDownstreamStale(steps: FlowStep[], stepId: RerunnableStepId) {
  const start = flowStepIds.indexOf(stepId) + 1;
  for (let index = start; index < steps.length; index += 1) {
    const step = steps[index];
    step.status = "stale";
    step.error = step.id === "claude_review" ? "Upstream Cursor review changed. Re-run recommended." : "Upstream review changed. Re-run recommended.";
  }
}

function requiredUpstream(stepId: RerunnableStepId) {
  if (stepId === "cursor_review") return ["codex_draft"] as const;
  if (stepId === "claude_review") return ["codex_draft", "cursor_review"] as const;
  return ["codex_draft", "cursor_review", "claude_review"] as const;
}

function canonicalStep(id: FlowStep["id"]): Pick<FlowStep, "id" | "agent" | "role"> {
  if (id === "codex_draft") return { id, agent: "codex", role: "draft" };
  if (id === "cursor_review") return { id, agent: "cursor", role: "review" };
  if (id === "claude_review") return { id, agent: "claude", role: "review" };
  return { id, agent: "codex", role: "final" };
}

function emit(handler: RerunOptions["onEvent"], event: ReviewRerunEvent) { handler?.(event); }
