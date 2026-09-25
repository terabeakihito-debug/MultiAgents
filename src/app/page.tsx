"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { agentIds, flowStepIds, type AgentId, type AgentResult, type AgentStatus, type FlowEvent, type FlowStep, type RerunnableStepId, type ReviewFlowResult, type ReviewRerunEvent } from "@/agents/types";
import { FlowEventParser } from "@/flows/sse";
import { acquireRunLock, releaseRunLock } from "./run-lock";
import { TaskDashboard } from "./task-dashboard";
import { NotificationCenter } from "./notification-center";
import { CredentialStatusPanel } from "./credential-status";
import { GitHubAccountPanel } from "./github-account-panel";
import { agentRoles, validationSteps, type ProjectProfile, type ProjectProfileSnapshot, type RolePolicy, type ValidationPolicy, type ValidationStep } from "@/profiles/policy";
import type { RepoTemplateSettings, TaskTemplate, TaskTemplateSnapshot } from "@/templates/policy";
import { humanPriorities, type Finding, type FindingEvent, type HumanPriority, type RemediationQueueItem } from "@/findings/types";
import type { PublicRuntimePolicy, RuntimeViolationRecord } from "@/runtime/types";
import { humanMutationFetch } from "./human-mutation";
import { ProjectOnboarding, type AddedProject } from "./project-onboarding";
import { historyEventStatusLabel, recoveryLabel, statusBadgeLabel, taskBehaviorExplanation, taskStatusLabel, templateNameLabel, worktreeLabel } from "./task-labels";
import { resolveStartTemplate, submitTaskStart, taskStartBlockReason } from "./task-start";
import { dependencyRecoveryPresentation, type PublicDependencyRecovery } from "./dependency-recovery";
import { canRerunFailedReviewStep } from "./review-rerun";
import { FlowStepAgentPanel } from "./flow-step-agent-panel";
import { defaultFlowStepAgents, type FlowStepAgentPlan } from "@/flows/step-agents";

const labels: Record<AgentId, string> = { codex: "Codex", cursor: "Cursor", claude: "Claude" };
const roleLabels = { draft: "下書き", review: "レビュー", final: "最終確認" } as const;
function executionRoleLabel(value: string) { return value === "implement" ? "実装" : value === "review_only" ? "レビューのみ" : value === "disabled" ? "無効" : value.replaceAll("_", " "); }
type Mode = "parallel" | "review";
type CardState = { status: AgentStatus; output: string; error?: string };
type Repo = { id: string; name: string; branch: string; dirty: boolean; initializationRequired?: boolean; initializationRepairRequired?: boolean; profile: ProjectProfile; templates: TaskTemplate[]; settings: RepoTemplateSettings };
type OpenPull = { number: number; title: string; url: string; draft: boolean; base: string; head: string; headSha: string };
type ValidationCheck = { name: string; status: "pass" | "fail" | "skip"; detail?: string };
type SecretFinding = { path: string; kind: "filename" | "content" | "limit"; rule: string };
type PrCheck = { name: string; state: string; bucket: "pass" | "fail" | "pending" | "skipping" | "unknown"; required: boolean; workflow?: string; link?: string };
type PrItem = { id: string; kind: "review" | "comment" | "thread" | "check"; author: string; body: string; state?: string; path?: string; line?: number; url?: string; resolved?: boolean; disposition: "informational" | "action_required" | "blocking" | "resolved"; reason: string; potentiallyAddressed?: boolean };
type PrStep = { id: string; agent: AgentId; status: "completed" | "error" | "skipped"; output: string; error?: string };
type PrReview = { number: number; title: string; url: string; state: string; draft: boolean; merged: boolean; base: string; head: string; headSha: string; mergeable: string; mergeStateStatus: string; changedFiles: Array<{ path: string; additions: number; deletions: number }>; checks: PrCheck[]; items: PrItem[]; reviewCount: number; unresolvedCount: number; fetchedAt: string };
type PrIntake = { status: "completed" | "error"; steps: PrStep[]; requiresRework: boolean; readyForHumanMerge: boolean };
type RepoTask = {
  id: string; repoId: string; repoName: string; branch: string; baseBranch: string; status: string; approvalState: string;
  approvalPurpose?: "create_pr" | "rework"; validation: ValidationCheck[]; secretFindings: SecretFinding[]; commitSha?: string; prUrl?: string; prNumber?: number;
  dependencyRecovery?: PublicDependencyRecovery;
  prReview?: PrReview; reviewIntake?: PrIntake; originalTaskAvailable: boolean; worktreeAvailable: boolean; latestPushedSha?: string; ciMessage?: string; error?: string;
  prompt: string; createdAt: string; updatedAt: string; flowId?: string; flowStatus?: string; flowSteps: FlowStep[]; finalOutput?: string;
  autonomous?: boolean;
  recoveryStatus: "recoverable" | "needs_attention" | "orphaned" | "invalid"; recoveryMessage?: string; worktreeStatus: "available" | "not_required" | "missing" | "removed" | "invalid";
  profile: ProjectProfileSnapshot;
  template: TaskTemplateSnapshot;
  sourceFindingId?: string;
  sourceTaskId?: string;
  runtimeViolation?: RuntimeViolationRecord;
};
type RuntimePolicyResponse = {
  runtimePolicyVersion: number; taskType: string; allAgentsReadOnly: boolean; worktreeRequired: boolean; networkEnforcementDescription: string;
  osSandbox: { status: "enforced"; validation: { validationNetwork: "blocked" }; agents: Array<{ agent: AgentId; profile: "agent_read_only" | "agent_implement" }> };
  policies: PublicRuntimePolicy[];
};
type TaskDiff = {
  trackedFiles: string[]; untrackedFiles: string[]; stat: string; patch: string; untrackedPatch: string;
  truncated: boolean; approvable: boolean; blockedReason?: string;
};
type Approval = { diffHash?: string; approvalId?: string; blockedReason?: string };
type DependencyRecoveryInstructions = { command?: string; error?: string };
type DependencyReadinessCheck = { status: "ready" | "missing" | "error"; message: string; checkedAt: string };
type ActionState = { status: "idle" | "running" | "success" | "error"; message: string };
type TaskEvent = { id: string; sequence: number; taskId: string; type: string; createdAt: string; actor: string; stepId?: string; status?: string; metadata?: Record<string, string | number> };
type StepVersion = { id: string; taskId: string; stepId: FlowStep["id"]; version: number; agent: AgentId; createdAt: string; output: string; status: FlowStep["status"]; durationMs?: number };
type DiffVersion = { id: string; taskId: string; version: number; diffHash: string; changedFileCount: number; additions: number; deletions: number; createdAt: string };
type ApprovalEvent = { id: string; sequence: number; taskId: string; approvalId: string; type: string; purpose: string; diffHash: string; createdAt: string; status?: string };
type TaskHistory = { events: TaskEvent[]; stepVersions: StepVersion[]; diffVersions: DiffVersion[]; approvalEvents: ApprovalEvent[] };
type FindingDetail = Finding & { remediation?: RemediationQueueItem; history?: FindingEvent[] };
const emptyHistory = (): TaskHistory => ({ events: [], stepVersions: [], diffVersions: [], approvalEvents: [] });
const initialCards = (): Record<AgentId, CardState> => ({ codex: { status: "idle", output: "" }, cursor: { status: "idle", output: "" }, claude: { status: "idle", output: "" } });
const initialSteps = (): FlowStep[] => [
  { id: "codex_draft", agent: "codex", role: "draft", status: "idle", output: "" },
  { id: "cursor_review", agent: "cursor", role: "review", status: "idle", output: "" },
  { id: "claude_review", agent: "claude", role: "review", status: "idle", output: "" },
  { id: "codex_final", agent: "codex", role: "final", status: "idle", output: "" },
];

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("parallel");
  const [, setCards] = useState(initialCards);
  const [steps, setSteps] = useState(initialSteps);
  const [flowStatus, setFlowStatus] = useState<ReviewFlowResult["status"] | "idle" | "running">("idle");
  const [finalOutput, setFinalOutput] = useState("");
  const [activeRerun, setActiveRerun] = useState<RerunnableStepId | null>(null);
  const [sending, setSending] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [autonomous, setAutonomous] = useState(false);
  const [templateOverrideId, setTemplateOverrideId] = useState<string | undefined>();
  const [, setOpenPulls] = useState<OpenPull[]>([]);
  const [task, setTask] = useState<RepoTask | null>(null);
  const [dashboardRefresh, setDashboardRefresh] = useState(0);
  const [dashboardView, setDashboardView] = useState<"tasks" | "findings" | "operations" | "settings">("tasks");
  const [stepAgents, setStepAgents] = useState<FlowStepAgentPlan>(() => defaultFlowStepAgents());
  const [advancedStart, setAdvancedStart] = useState(false);
  const [detailTab, setDetailTab] = useState<"overview" | "changes" | "history" | "technical">("overview");
  const [taskDiff, setTaskDiff] = useState<TaskDiff | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [reviewedDiff, setReviewedDiff] = useState(false);
  const [approvalProcessing, setApprovalProcessing] = useState(false);
  const [setupCommand, setSetupCommand] = useState("");
  const [setupCommandLoading, setSetupCommandLoading] = useState(false);
  const [dependencyCheck, setDependencyCheck] = useState<DependencyReadinessCheck | null>(null);
  const [dependencyCheckLoading, setDependencyCheckLoading] = useState(false);
  const [diffRefreshState, setDiffRefreshState] = useState<ActionState>({ status: "idle", message: "" });
  const [reviewProcessing, setReviewProcessing] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [taskStartError, setTaskStartError] = useState("");
  const [taskHistory, setTaskHistory] = useState<TaskHistory>(emptyHistory);
  const [historyTitle, setHistoryTitle] = useState("");
  const [findings, setFindings] = useState<FindingDetail[]>([]);
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicyResponse | null>(null);
  const sendingRef = useRef(false);
  const flowAbortRef = useRef<AbortController | null>(null);

  async function refreshRepositories(preferredId?: string) { await fetch("/api/repos").then(async (response) => {
    const data = await response.json() as { repos?: Repo[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Could not load repositories");
    setRepos(data.repos || []);
    const selected = data.repos?.find((repo) => repo.id === preferredId) ?? data.repos?.[0];
    setRepoId((current) => preferredId ? selected?.id || current : current || selected?.id || "");
    setTemplateOverrideId(undefined);
    setTemplateId((current) => preferredId ? selected?.settings.defaultTemplateId || "" : current || selected?.settings.defaultTemplateId || "");
  }).catch((error) => setTaskError(message(error))); }

  useEffect(() => { void refreshRepositories(); }, []);

  useEffect(() => {
    setStepAgents(defaultFlowStepAgents());
  }, [repoId, templateId]);

  function projectAdded(project: AddedProject, needsInitialCommit: boolean) {
    void refreshRepositories(project.id);
    if (needsInitialCommit) setDashboardRefresh((value) => value + 1);
  }

  useEffect(() => {
    if (!task?.id) { setRuntimePolicy(null); return; }
    const controller = new AbortController();
    void fetch(`/api/tasks/${task.id}/runtime-policy`, { signal: controller.signal }).then(async (response) => {
      const data = await response.json() as RuntimePolicyResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "Runtime policy could not be loaded");
      setRuntimePolicy(data);
    }).catch((error: unknown) => { if (!controller.signal.aborted) setTaskError(message(error)); });
    return () => controller.abort();
  }, [task?.id]);

  useEffect(() => { setSetupCommand(""); }, [task?.id]);
  useEffect(() => { setDependencyCheck(null); }, [task?.id]);
  useEffect(() => { setDiffRefreshState({ status: "idle", message: "" }); }, [task?.id]);

  async function loadTaskHistory(taskId: string) {
    const response = await fetch(`/api/tasks/${taskId}/history`);
    const data = await response.json() as { history?: TaskHistory; error?: string };
    if (!response.ok || !data.history) throw new Error(data.error || "Could not load task history");
    setTaskHistory(data.history);
  }

  async function loadTaskFindings(taskId: string) {
    const response = await fetch(`/api/tasks/${taskId}/findings`);
    const data = await response.json() as { findings?: FindingDetail[]; error?: string };
    if (!response.ok || !data.findings) throw new Error(data.error || "Could not load findings");
    setFindings(data.findings);
  }

  async function openDashboardHistory(taskId: string, label: string) {
    setTaskError("");
    try { await loadTaskHistory(taskId); setHistoryTitle(label); }
    catch (error) { setTaskError(message(error)); }
  }

  async function resumePersistedTask(taskId: string) {
    setTaskError(""); setTaskDiff(null); setApproval(null); setReviewedDiff(false); setTaskHistory(emptyHistory()); setFindings([]);
    try {
      const response = await humanMutationFetch(`/api/tasks/${taskId}/resume`, "task-resume", { method: "POST" });
      const data = await response.json() as { diff?: TaskDiff; task?: RepoTask; approval?: Approval; error?: string };
      if (!data.task) throw new Error(data.error || "Task resume failed");
      const restored = data.task;
      setTask(restored); setRepoId(restored.repoId); setTemplateId(restored.template.templateId); setMode(restored.template.executionMode === "parallel" ? "parallel" : "review"); setPrompt(restored.prompt);
      setSteps(restored.flowSteps?.length ? restored.flowSteps : initialSteps());
      setFlowStatus((restored.flowStatus as ReviewFlowResult["status"] | "idle" | "running") ?? "idle");
      setFinalOutput(restored.finalOutput ?? "");
      setTaskDiff(data.diff ?? null); setApproval(data.approval ?? null);
      if (data.error) setTaskError(data.error);
      await loadTaskHistory(restored.id); setHistoryTitle(""); setDashboardRefresh((value) => value + 1);
      if (["security_review", "investigation"].includes(restored.template.taskType)) await loadTaskFindings(restored.id);
    } catch (error) { setTaskError(message(error)); }
  }

  async function createIsolatedTask(resolvedTemplateId: string) {
    if (!repoId || !resolvedTemplateId || !prompt.trim()) return;
    await submitTaskStart({
      form: { repoId, templateId: resolvedTemplateId, prompt, explicitOverrideId: templateOverrideId },
      acquire: () => acquireRunLock(sendingRef), release: () => releaseRunLock(sendingRef), setBusy: setSending,
      clearError: () => setTaskStartError(""), setError: setTaskStartError,
      request: async (form) => {
        setTaskDiff(null); setApproval(null); setReviewedDiff(false); setOpenPulls([]); setTaskHistory(emptyHistory()); setFindings([]);
        const response = await humanMutationFetch("/api/tasks", "task-create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoId: form.repoId, templateId: form.templateId, prompt: form.prompt, autonomous: autonomous && !selectedTemplate?.readOnly, stepAgents }) });
        const data = await response.json() as { task?: RepoTask; error?: string };
        if (!response.ok || !data.task) throw new Error(data.error || "タスクの開始に失敗しました。");
        setTask(data.task); setMode(data.task.template.executionMode === "parallel" ? "parallel" : "review"); await loadTaskHistory(data.task.id); setDashboardRefresh((value) => value + 1);
        await runFlow(data.task, form.prompt);
      },
    });
  }

  async function loadOpenPulls() {
    if (!repoId || reviewProcessing) return;
    setReviewProcessing(true); setTaskError("");
    try {
      const response = await fetch(`/api/repos/${encodeURIComponent(repoId)}/pulls`);
      const data = await response.json() as { pulls?: OpenPull[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not list pull requests");
      setOpenPulls(data.pulls ?? []);
    } catch (error) { setTaskError(message(error)); }
    finally { setReviewProcessing(false); }
  }

  async function refreshDiff(activeTask = task) {
    if (!activeTask) return;
    setDiffRefreshState({ status: "running", message: "差分を確認しています…" });
    try {
      const response = await humanMutationFetch(`/api/tasks/${activeTask.id}/prepare-approval`, "task-prepare-approval", { method: "POST" });
      const data = await response.json() as { diff?: TaskDiff; task?: RepoTask; approval?: Approval; error?: string };
      if (data.task) setTask(data.task);
      if (!data.diff) throw new Error(data.error || "差分を読み込めませんでした。");
      const previousHash = approval?.diffHash;
      const previousApprovalId = approval?.approvalId;
      setTaskDiff(data.diff);
      setApproval(data.approval ?? null);
      if (!data.approval?.diffHash || data.approval.diffHash !== previousHash || data.approval.approvalId !== previousApprovalId) setReviewedDiff(false);
      await loadTaskHistory(activeTask.id);
      if (!response.ok && data.error) setTaskError(data.error);
      setDiffRefreshState({ status: "success", message: "差分を確認しました。下の変更内容を確認してください。" });
    } catch (error) {
      const detail = message(error);
      setDiffRefreshState({ status: "error", message: `差分を確認できませんでした。${detail}` });
      throw error;
    }
  }

  async function showSetupCommand(activeTask = task) {
    if (!activeTask || setupCommandLoading) return;
    setSetupCommandLoading(true);
    setTaskError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${activeTask.id}/dependency-recovery-instructions`, "task-dependency-recovery-instructions", { method: "POST" });
      const data = await response.json() as DependencyRecoveryInstructions;
      if (!response.ok || !data.command) throw new Error(data.error || "Setup instructions are unavailable");
      setSetupCommand(data.command);
    } catch (error) { setTaskError(message(error)); }
    finally { setSetupCommandLoading(false); }
  }

  async function checkDependencyReadiness(activeTask = task) {
    if (!activeTask || dependencyCheckLoading) return;
    setDependencyCheckLoading(true);
    setTaskError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${activeTask.id}/dependency-recovery-check`, "task-dependency-recovery-check", { method: "POST" });
      const data = await response.json() as DependencyReadinessCheck & { error?: string };
      if (!response.ok || !data.status) throw new Error(data.error || "依存関係を確認できませんでした。");
      setDependencyCheck(data);
    } catch (error) { setTaskError(message(error)); }
    finally { setDependencyCheckLoading(false); }
  }

  async function deleteWorktree() {
    if (!task) return;
    setTaskError("");
    const response = await humanMutationFetch(`/api/tasks/${task.id}`, "task-delete", { method: "DELETE" });
    if (!response.ok) { const data = await response.json() as { error?: string }; setTaskError(data.error || "整理する failed"); return; }
    setTask(null); setTaskDiff(null); setApproval(null); setReviewedDiff(false); setTaskHistory(emptyHistory()); setFindings([]); setAutonomous(false);
    setDashboardRefresh((value) => value + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !acquireRunLock(sendingRef)) return;
    setSending(true);
    try { if (mode === "parallel") await runParallel(); else await runFlow(); }
    finally { releaseRunLock(sendingRef); setSending(false); }
  }

  async function runTaskFlow() {
    if (!prompt.trim() || !acquireRunLock(sendingRef)) return;
    setSending(true);
    try { await runFlow(); }
    finally { releaseRunLock(sendingRef); setSending(false); }
  }

  async function runParallel() {
    setCards(Object.fromEntries(agentIds.map((id) => [id, { status: "running", output: "" }])) as Record<AgentId, CardState>);
    try {
      const response = await humanMutationFetch("/api/agents/parallel", "agent-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
      const data = await response.json() as { results?: AgentResult[]; error?: string };
      if (!response.ok || !data.results || data.results.length !== agentIds.length) throw new Error(data.error || `リクエストに失敗しました（${response.status}）。`);
      setCards(Object.fromEntries(data.results.map((result) => [result.agent, { status: result.status, output: result.output, error: result.error }])) as Record<AgentId, CardState>);
    } catch (error) {
      setCards(Object.fromEntries(agentIds.map((id) => [id, { status: "error", output: "", error: message(error) }])) as Record<AgentId, CardState>);
    }
  }

  async function runFlow(activeTask: RepoTask | null = task, activePrompt = prompt) {
    setFlowStatus("running");
    setSteps(initialSteps());
    setFinalOutput("");
    const abortController = new AbortController();
    flowAbortRef.current = abortController;
    try {
      const response = await humanMutationFetch("/api/flows/review/stream", "review-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: activePrompt, taskId: activeTask?.id }), signal: abortController.signal });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || `リクエストに失敗しました（${response.status}）。`);
      }
      if (!response.body) throw new Error("Streaming response body is unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new FlowEventParser();
      while (true) {
        const { value, done } = await reader.read();
        for (const flowEvent of parser.push(decoder.decode(value, { stream: !done }))) applyFlowEvent(flowEvent as FlowEvent);
        if (done) break;
      }
      if (activeTask) await refreshDiff(activeTask);
    } catch (error) {
      const aborted = abortController.signal.aborted;
      setFlowStatus(aborted ? "aborted" : "error");
      setSteps((current) => current.map((step) => step.status === "running"
        ? { ...step, status: "error", error: aborted ? "Request was aborted" : message(error) }
        : step.status === "idle" ? { ...step, status: "skipped", error: aborted ? "Request was aborted" : "Flow request failed" } : step));
    } finally {
      if (flowAbortRef.current === abortController) flowAbortRef.current = null;
    }
  }

  async function rerunStep(stepId: RerunnableStepId) {
    if (!task || !acquireRunLock(sendingRef)) return;
    setSending(true);
    setActiveRerun(stepId);
    const abortController = new AbortController();
    flowAbortRef.current = abortController;
    try {
      const response = await humanMutationFetch("/api/flows/review/rerun", "review-rerun", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal,
        body: JSON.stringify({ taskId: task.id, stepId }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || `リクエストに失敗しました（${response.status}）。`);
      }
      if (!response.body) throw new Error("Streaming response body is unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new FlowEventParser();
      while (true) {
        const { value, done } = await reader.read();
        for (const streamEvent of parser.push(decoder.decode(value, { stream: !done }))) applyRerunEvent(streamEvent as ReviewRerunEvent);
        if (done) break;
      }
      if (task) await refreshDiff(task);
    } catch (error) {
      const aborted = abortController.signal.aborted;
      setSteps((current) => current.map((step) => step.id === stepId
        ? { ...step, status: "error", error: `Re-run failed: ${aborted ? "Request was aborted" : message(error)}` }
        : step));
    } finally {
      if (flowAbortRef.current === abortController) flowAbortRef.current = null;
      setActiveRerun(null);
      releaseRunLock(sendingRef);
      setSending(false);
    }
  }

  function applyFlowEvent(event: FlowEvent) {
    if (event.type === "flow_started") { setFlowStatus("running"); return; }
    if ("step" in event) {
      setSteps((current) => current.map((step) => step.id === event.step.id ? event.step : step));
      return;
    }
    setSteps(event.result.steps);
    setFinalOutput(event.result.finalOutput);
    setFlowStatus(event.result.status);
  }

  function applyRerunEvent(event: ReviewRerunEvent) {
    if (event.type === "rerun_started") return;
    if ("step" in event) {
      setSteps((current) => current.map((step) => step.id === event.step.id ? event.step : step));
      return;
    }
    setSteps(event.result.steps);
    setFinalOutput(event.result.finalOutput);
    setFlowStatus(event.result.status);
  }


  async function approveFinalDiff() {
    if (!task || !reviewedDiff || !approval?.diffHash || !approval.approvalId || approvalProcessing) return;
    setApprovalProcessing(true);
    setTaskError("");
    const poll = setInterval(() => {
      void fetch(`/api/tasks/${task.id}`).then(async (response) => {
        const data = await response.json() as { task?: RepoTask };
        if (response.ok && data.task) setTask(data.task);
      }).catch(() => undefined);
    }, 1_000);
    try {
      const rework = task.approvalPurpose === "rework";
      const response = await humanMutationFetch(`/api/tasks/${task.id}/${rework ? "approve-rework" : "approve"}`, rework ? "task-approve-rework" : "task-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, diffHash: approval.diffHash, approvalId: approval.approvalId }),
      });
      const data = await response.json() as { task?: RepoTask; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error || (rework ? "Rework approval failed" : "Approve and create PR failed"));
      setTask(data.task);
      setApproval(null);
      setReviewedDiff(false);
      await loadTaskHistory(data.task.id);
    } catch (error) {
      setTaskError(message(error));
      try { await refreshDiff(task); } catch { /* retain the operation error */ }
    } finally {
      clearInterval(poll);
      setApprovalProcessing(false);
    }
  }

  async function fetchPrReview() {
    if (!task || reviewProcessing) return;
    setReviewProcessing(true); setTaskError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}/fetch-review`, "task-fetch-review", { method: "POST" });
      const data = await response.json() as { task?: RepoTask; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error || "PR review fetch failed");
      setTask(data.task); setReviewedDiff(false); await loadTaskHistory(data.task.id);
    } catch (error) { setTaskError(message(error)); }
    finally { setReviewProcessing(false); }
  }

  async function applyReviewFixes() {
    if (!task || reviewProcessing) return;
    setReviewProcessing(true); setTaskError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}/apply-review`, "task-apply-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true }) });
      const data = await response.json() as { task?: RepoTask; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error || "PR rework failed");
      setTask(data.task); await refreshDiff(data.task);
    } catch (error) { setTaskError(message(error)); }
    finally { setReviewProcessing(false); }
  }

  async function retryPr() {
    if (!task || approvalProcessing) return;
    setApprovalProcessing(true);
    setTaskError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}/create-pr`, "task-create-pr", { method: "POST" });
      const data = await response.json() as { task?: RepoTask; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error || "PR retry failed");
      setTask(data.task); await loadTaskHistory(data.task.id);
    } catch (error) { setTaskError(message(error)); }
    finally { setApprovalProcessing(false); }
  }

  const selectedProfile = repos.find((repo) => repo.id === repoId)?.profile;
  const selectedRepo = repos.find((repo) => repo.id === repoId);
  const resolvedStartTemplate = resolveStartTemplate(selectedRepo, templateOverrideId);
  const selectedTemplate = resolvedStartTemplate.template;
  const selectedRepoTemplate = selectedRepo?.templates.find((item) => item.templateId === selectedTemplate?.templateId);

  return <main>
    <header className="appHeader"><div><h1>MultiAgents</h1><p>リポジトリの作業を開始し、確認し、安全に引き継ぎます。</p></div><NotificationCenter repos={repos} refreshToken={dashboardRefresh} onOpenTask={(id) => { setDashboardView("tasks"); void resumePersistedTask(id); }} onError={setTaskError} /></header>
    <TaskDashboard repos={repos} busy={sending || approvalProcessing || reviewProcessing} refreshToken={dashboardRefresh} view={dashboardView} onViewChange={setDashboardView} onResume={(id) => { setDashboardView("tasks"); void resumePersistedTask(id); }} onHistory={(id, label) => { setDashboardView("tasks"); void openDashboardHistory(id, label); }} onError={setTaskError} startTask={!task ? <StartTaskPanel repos={repos} repoId={repoId} templateId={selectedTemplate?.templateId || ""} prompt={prompt} autonomous={autonomous} sending={sending} profileEnabled={selectedProfile?.enabled !== false} selectedRepo={selectedRepo} resolution={resolvedStartTemplate.source} taskStartError={taskStartError} stepAgents={stepAgents} onStepAgents={setStepAgents} onRepo={(id) => { const next = repos.find((repo) => repo.id === id); setRepoId(id); setTemplateOverrideId(undefined); setTemplateId(next?.settings.defaultTemplateId || ""); setAutonomous(false); setTaskStartError(""); }} onTemplate={(id) => { setTemplateOverrideId(id); setTemplateId(id); setAutonomous(false); setTaskStartError(""); }} onPrompt={(value) => { setPrompt(value); if (value !== prompt) setTaskStartError(""); }} onAutonomous={setAutonomous} onStart={() => void createIsolatedTask(selectedTemplate?.templateId || "")} onProjectAdded={projectAdded} onError={() => undefined} onOpenSettings={() => setDashboardView("settings")} /> : null} settings={<section className="settingsPanel"><span className="eyebrow">設定</span><h2>設定</h2><p className="muted">ここでの変更は今後のタスクに適用されます。通常のタスク作業に設定変更は不要です。</p><GitHubAccountPanel /><ProjectOnboarding disabled={sending || approvalProcessing || reviewProcessing || Boolean(task)} onAdded={projectAdded} onError={setTaskError} initializationRequiredProject={selectedRepo?.initializationRequired || selectedRepo?.initializationRepairRequired ? selectedRepo : undefined} initializationRepairRequired={selectedRepo?.initializationRepairRequired === true} /><CredentialStatusPanel />{selectedRepo && selectedRepoTemplate?.executionMode === "review_flow" ? <FlowStepAgentPanel profile={selectedRepo.profile} template={selectedRepoTemplate} value={stepAgents} disabled={sending || approvalProcessing || reviewProcessing || Boolean(task)} onChange={setStepAgents} /> : null}{selectedRepo ? <><ProfilePanel repoId={repoId} profile={selectedRepo.profile} disabled={sending || approvalProcessing || reviewProcessing || Boolean(task)} onSaved={(profile) => { setRepos((current) => current.map((repo) => repo.id === repoId ? { ...repo, profile } : repo)); setDashboardRefresh((value) => value + 1); }} onError={setTaskError} /><TemplatePanel repo={selectedRepo} selectedTemplateId={selectedTemplate?.templateId || templateId} disabled={sending || approvalProcessing || reviewProcessing || Boolean(task)} onSelected={(id) => { setTemplateOverrideId(id); setTemplateId(id); }} onSaved={(data) => setRepos((current) => current.map((repo) => repo.id === selectedRepo.id ? { ...repo, ...data } : repo))} onError={setTaskError} /></> : null}</section>} />
    {dashboardView === "tasks" ? <>
    {taskError ? <ErrorBlock error={taskError} /> : null}
    {historyTitle ? <section className="dashboardHistory"><div className="cardHeader"><div><span className="eyebrow">タスクの履歴</span><h2>{historyTitle}</h2></div><button type="button" className="secondary" onClick={() => { setHistoryTitle(""); setTaskHistory(emptyHistory()); }}>閉じる</button></div><TaskHistoryPanel history={taskHistory} /></section> : null}
    {false ? <section className="repoPanel startTask" aria-labelledby="start-task-title"><span className="eyebrow">Start a task</span><h2 id="start-task-title">New Task</h2><div className="guidedSteps"><label><span>Step 1 — Repository</span><select id="repository" value={repoId} disabled={sending} onChange={(event) => { const next = repos.find((repo) => repo.id === event.target.value); setRepoId(event.target.value); setTemplateId(next?.settings.defaultTemplateId || ""); }}>{repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}{repo.dirty ? " (needs attention)" : ""}</option>)}</select></label><fieldset className="taskTypes"><legend>Step 2 — Task type</legend>{selectedRepo?.templates.filter((template) => template.enabled).map((template) => <label key={template.templateId} className={templateId === template.templateId ? "selected" : ""}><input type="radio" checked={templateId === template.templateId} onChange={() => setTemplateId(template.templateId)} /><strong>{template.name}</strong><small>{template.description}</small>{template.readOnly ? <em>Read-only · no worktree, commit, or PR</em> : null}</label>)}</fieldset></div>
    <form onSubmit={submit}>
      <label htmlFor="prompt">Step 3 — Task description</label>
      <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20_000} rows={6} placeholder="Describe the repository task, or ask Codex, Cursor, and Claude…" />
      <details className="advancedStart" open={advancedStart}><summary onClick={(event) => { event.preventDefault(); setAdvancedStart((value) => !value); }}>Advanced settings</summary><p>Technical execution options are configured in Settings. This task uses the selected safe task type.</p><button type="button" className="secondary" onClick={loadOpenPulls}>{reviewProcessing ? "Loading…" : "Find an existing PR"}</button></details>
      <div className="actions"><span>Step 4</span><button type="button" disabled={!repoId || !selectedTemplate || !prompt.trim() || sending || selectedProfile?.enabled === false} onClick={() => void createIsolatedTask(templateId)}>{sending ? "Starting…" : "Start task"}</button></div>
    </form></section> : task ? <TaskDetail task={task} tab={detailTab} onTab={setDetailTab} onDelete={deleteWorktree} onRun={() => void runTaskFlow()} onCheckDependencies={() => void checkDependencyReadiness()} dependencyCheck={dependencyCheck} dependencyCheckLoading={dependencyCheckLoading} busy={sending || approvalProcessing || reviewProcessing || dependencyCheckLoading} /> : null}
    {task && detailTab === "overview" ? <FlowTimeline steps={steps} versions={taskHistory.stepVersions} status={flowStatus} finalOutput={finalOutput} sending={sending} activeRerun={activeRerun} rerunAvailable={Boolean(task)} onRerun={rerunStep} /> : null}
    {task && detailTab === "technical" && runtimePolicy ? <RuntimePolicyPanel task={task} runtime={runtimePolicy} /> : null}
    {task?.runtimeViolation ? <section className="runtimeViolation" role="alert"><strong>対応が必要です</strong><h2>実行ポリシー違反</h2><p>{task.runtimeViolation.message}</p><p>担当者の確認が必要です。commit、push、承認、PR操作は実行できません。</p></section> : null}
    {task && ["security_review", "investigation"].includes(task.template.taskType) ? <FindingsPanel task={task} templates={selectedRepo?.templates ?? []} findings={findings} busy={sending || reviewProcessing} onFindings={setFindings} onOpenTask={(id) => void resumePersistedTask(id)} onHistoryRefresh={() => void loadTaskHistory(task.id)} onDashboardRefresh={() => setDashboardRefresh((value) => value + 1)} onError={setTaskError} /> : null}
    {taskDiff && detailTab === "changes" && <ApprovalNextStepPanel reviewedDiff={reviewedDiff} approvalReady={Boolean(approval?.diffHash && approval?.approvalId)} />}
    {taskDiff && detailTab === "changes" && <section className="diff card"><h2>変更内容</h2><p className="sectionIntro">このTaskで変更されたファイルを確認してください。意図した変更だけなら、下の確認欄から承認に進みます。</p><h3>変更されたファイル</h3><pre>{taskDiff.trackedFiles.join("\n") || "なし"}</pre><h3>未追跡ファイル</h3><pre>{taskDiff.untrackedFiles.join("\n") || "なし"}</pre><h3>変更の概要</h3><pre>{taskDiff.stat || "変更された行はありません"}</pre><details><summary>差分をすべて表示</summary><pre>{[taskDiff.patch, taskDiff.untrackedPatch].filter(Boolean).join("\n\n") || "差分はありません"}</pre></details>{taskDiff.blockedReason && <p className="staleReason">{taskDiff.blockedReason}</p>}
      {(task?.validation.length || approvalProcessing) && <div className="validation"><h3>PR作成前の検証</h3>{task?.validation.map((check, index) => <div className="validationRow" key={`${check.name}-${index}`}><span>{check.name}</span><Status domain="validation" value={check.status} /><span>{check.detail}</span></div>)}{approvalProcessing && <p>サーバーで検証とPR作成を実行しています…</p>}</div>}
    {task && dependencyRecoveryPresentation(task.dependencyRecovery) ? <section className="dependencyRecovery" aria-labelledby="dependency-recovery-title"><span className="eyebrow">復旧</span><h3 id="dependency-recovery-title">依存関係の準備が必要</h3><p><strong>最初に確認:</strong> 「依存関係を確認」を押すと、作業ツリーの node_modules と npm ls --offline の結果を確認できます。npm install は実行しません。</p><p className="actionAudience">操作できる人: 人（このブラウザを操作している担当者）。エージェントは実行できません。</p>{dependencyCheck ? <DependencyCheckResultView result={dependencyCheck} nextAction={task.status === "draft" && task.flowStatus === "error" ? "確認済みなら「レビューを再実行」を押してください。" : "確認済みなら「差分を再確認」を押してください。"} /> : null}{setupCommand ? <div className="actionResult actionResult-success" role="status"><strong>セットアップ手順を表示しました</strong><p>内容を確認して、必要ならWSLで手動実行してください。MultiAgentsはインストールしません。</p><pre><code>{setupCommand}</code></pre></div> : null}<div className="inlineActions"><button type="button" className="secondary" disabled={approvalProcessing || sending || setupCommandLoading || dependencyCheckLoading} onClick={() => void showSetupCommand(task)}>{setupCommandLoading ? "読み込み中…" : "セットアップ手順を表示"}</button><button type="button" className="secondary" disabled={approvalProcessing || sending || setupCommandLoading || dependencyCheckLoading} onClick={() => void checkDependencyReadiness(task)}>{dependencyCheckLoading ? "確認中…" : "依存関係を確認"}</button></div>{task.status === "draft" && task.flowStatus === "error" ? <><p className="actionAudience">依存関係が「確認済み」になった後だけ、レビューを再実行できます。</p><button type="button" disabled={approvalProcessing || sending || dependencyCheck?.status !== "ready"} onClick={() => void runTaskFlow()}>{sending ? "開始中…" : "レビューを再実行"}</button></> : <><ActionResult state={diffRefreshState} /><button type="button" className="secondary" disabled={approvalProcessing || sending || dependencyCheck?.status !== "ready" || diffRefreshState.status === "running"} onClick={() => void refreshDiff(task)}>{diffRefreshState.status === "running" ? "確認中…" : "差分を再確認"}</button></>}</section> : null}
      {task?.secretFindings.length ? <div className="error"><strong>機密情報の可能性</strong><ul>{task.secretFindings.map((finding, index) => <li key={`${finding.path}-${finding.rule}-${index}`}><code>{finding.path}</code>: {finding.rule}</li>)}</ul></div> : null}
      {approval?.diffHash && approval.approvalId && <div className="approval"><p>変更内容の確認 ↓ 承認 ↓ 検証 ↓ コミット ↓ PR作成</p><p className="actionAudience">操作できる人: 人。差分を確認した担当者だけが承認できます。</p><label><input type="checkbox" checked={reviewedDiff} disabled={sending || approvalProcessing} onChange={(event) => setReviewedDiff(event.target.checked)} /> この最終差分を確認しました</label><button type="button" disabled={!reviewedDiff || sending || approvalProcessing} onClick={approveFinalDiff}>{approvalProcessing ? "検証中…" : task?.approvalPurpose === "rework" ? "承認して既存PRを更新" : "承認してPRを作成"}</button><details><summary>技術情報を表示</summary><code>{approval.diffHash}</code></details></div>}
      {approval?.blockedReason && <p className="staleReason">{approval.blockedReason}</p>}
      {task?.status === "pr_failed" && <button type="button" className="rerun" disabled={approvalProcessing} onClick={retryPr}>PR作成を再試行</button>}
      {task?.status === "pr_created" && task.prUrl && <div className="prCreated"><h3>PRを作成しました</h3><p><strong>ブランチ:</strong> <code>{task.branch}</code></p><p><strong>コミット:</strong> <code>{task.commitSha}</code></p><p><strong>プルリクエスト:</strong> #{task.prNumber} <a href={task.prUrl} target="_blank" rel="noreferrer">{task.prUrl}</a></p><p>作業ツリーは保持されています。マージは実行していません。</p></div>}
    </section>}
    {task?.prNumber && detailTab === "changes" && <PrReviewPanel task={task} processing={reviewProcessing} onFetch={fetchPrReview} onApply={applyReviewFixes} />}
    {task && detailTab === "history" && <TaskHistoryPanel history={taskHistory} />}
    </> : null}
  </main>;
}

function ApprovalNextStepPanel({ reviewedDiff, approvalReady }: { reviewedDiff: boolean; approvalReady: boolean }) {
  const message = !approvalReady
    ? "差分を再確認すると、承認に必要な情報が更新されます。"
    : reviewedDiff
      ? "確認欄にチェック済みです。下の承認ボタンを押せます。"
      : "差分を確認したら、下の確認欄にチェックを入れてください。";
  return <section className="nextActionPanel" aria-labelledby="next-action-title"><span className="eyebrow">次の操作</span><h2 id="next-action-title">変更内容を確認して承認する</h2><p>{message}</p><ol><li><strong>差分をすべて表示</strong>を開き、意図した変更だけか確認する</li><li><strong>この最終差分を確認しました</strong>にチェックする</li><li><strong>承認してPRを作成</strong>を押す</li></ol></section>;
}

function ActionResult({ state }: { state: ActionState }) {
  if (state.status === "idle") return null;
  const title = state.status === "running" ? "処理中" : state.status === "success" ? "完了" : "確認できませんでした";
  return <div className={`actionResult actionResult-${state.status}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite"><strong>{title}</strong><p>{state.message}</p></div>;
}

function StartTaskPanel({ repos, repoId, templateId, prompt, autonomous, sending, profileEnabled, selectedRepo, resolution, taskStartError, stepAgents, onStepAgents, onRepo, onTemplate, onPrompt, onAutonomous, onStart, onProjectAdded, onError, onOpenSettings }: { repos: Repo[]; repoId: string; templateId: string; prompt: string; autonomous: boolean; sending: boolean; profileEnabled: boolean; selectedRepo?: Repo; resolution: "override" | "default" | "only_enabled" | "selection_required" | "none_enabled"; taskStartError: string; stepAgents: FlowStepAgentPlan; onStepAgents: (plan: FlowStepAgentPlan) => void; onRepo: (id: string) => void; onTemplate: (id: string) => void; onPrompt: (value: string) => void; onAutonomous: (value: boolean) => void; onStart: () => void; onProjectAdded: (project: AddedProject, needsInitialCommit: boolean) => void; onError: (error: string) => void; onOpenSettings: () => void }) {
  const selectedTemplate = selectedRepo?.templates.find((template) => template.templateId === templateId);
  const enabledTemplates = selectedRepo?.templates.filter((template) => template.enabled) ?? [];
  const initializationBlocked = selectedRepo?.initializationRequired || selectedRepo?.initializationRepairRequired;
  const noEnabledTemplate = Boolean(selectedRepo) && enabledTemplates.length === 0;
  const selectionRequired = resolution === "selection_required";
  const blockedReason = taskStartBlockReason({ hasRepository: Boolean(repoId), prompt, hasTemplate: Boolean(selectedTemplate), profileEnabled, initializationRequired: Boolean(selectedRepo?.initializationRequired), initializationRepairRequired: Boolean(selectedRepo?.initializationRepairRequired), selectionRequired });
  return <section className="startTaskWide" aria-labelledby="start-task-title"><div className="startTaskHeading"><div><span className="eyebrow">新しいタスク</span><h2 id="start-task-title">プロジェクトを選んで、やりたいことを書いてください</h2></div><p>タスクの種類と安全な実行ルールは、プロジェクトの設定に従って自動的に選ばれます。</p></div>{selectedRepo && selectedTemplate && selectedTemplate.executionMode === "review_flow" ? <FlowStepAgentPanel profile={selectedRepo.profile} template={selectedTemplate} value={stepAgents} disabled={sending} onChange={onStepAgents} /> : null}<div className="startFields"><label>プロジェクト<div className="repositorySelect"><select id="task-project" value={repoId} disabled={sending || repos.length === 0} onChange={(event) => onRepo(event.target.value)}><option value="">{repos.length ? "プロジェクトを選択" : "プロジェクトがありません"}</option>{repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}{repo.dirty ? "（確認が必要）" : ""}</option>)}</select><ProjectOnboarding disabled={sending} onAdded={onProjectAdded} onError={onError} initializationRequiredProject={initializationBlocked ? selectedRepo : undefined} initializationRepairRequired={selectedRepo?.initializationRepairRequired === true} /></div></label></div>{!repos.length ? <p className="taskStartNotice" role="status">まずプロジェクトを追加してください。</p> : null}{!profileEnabled && selectedRepo ? <p className="taskStartNotice" role="alert">このプロジェクトは新しいタスクの開始を停止しています。<button type="button" className="textButton" onClick={onOpenSettings}>設定で確認</button></p> : null}{noEnabledTemplate ? <p className="taskStartNotice" role="alert">このプロジェクトでは利用できるタスクの種類がありません。<button type="button" className="textButton" onClick={onOpenSettings}>設定で有効にしてください。</button></p> : null}{selectionRequired ? <p className="taskStartNotice" role="alert">利用できるタスクの種類を選択してください。</p> : null}{taskStartError ? <p className="taskStartNotice error" role="alert">{taskStartError}</p> : null}<label className="taskDescription" htmlFor="task-prompt">何をしてほしいですか？<textarea id="task-prompt" value={prompt} onChange={(event) => onPrompt(event.target.value)} maxLength={20_000} rows={5} placeholder="ログイン画面のエラー表示を分かりやすくしてください" disabled={sending} /></label>{selectedTemplate && !selectedTemplate.readOnly ? <label className="taskAutonomous"><input type="checkbox" checked={autonomous} disabled={sending} onChange={(event) => onAutonomous(event.target.checked)} /> 自律実行（検証失敗時に最大2回まで修正を試みる。commit・push・PRは人が承認します）</label> : null}<div className="startTaskFooter"><p className="taskBehavior">{taskBehaviorExplanation(selectedTemplate)}</p><p className="actionAudience">操作できる人: 人。タスクの開始・自律実行の選択・設定変更は担当者が行います。</p>{enabledTemplates.length > 1 ? <details className="taskTypeDisclosure"><summary>タスクの種類を変更</summary><label htmlFor="task-template">タスクの種類<select id="task-template" value={templateId} disabled={sending} onChange={(event) => onTemplate(event.target.value)}><option value="" disabled>タスクの種類を選択</option>{enabledTemplates.map((template) => <option key={template.templateId} value={template.templateId}>{templateNameLabel(template.name)}{template.readOnly ? "（変更しません）" : ""}</option>)}</select></label>{selectedTemplate ? <p>{templateDescriptionLabel(selectedTemplate.description)}{selectedTemplate.readOnly ? " このタスクはリポジトリを変更しません。" : ""}</p> : null}</details> : null}<button type="button" disabled={Boolean(blockedReason) || sending} onClick={onStart}>{initializationBlocked ? "プロジェクトの設定を完了してください" : sending ? "開始しています…" : "タスクを開始"}</button></div></section>;
}

function templateDescriptionLabel(description: string | undefined) {
  return description === "Fix a defect using isolated implementation and independent review." ? "隔離された作業領域で不具合を修正し、独立したレビューを行います。" : description ?? "";
}

function executionModeLabel(value: string) {
  return value === "review_flow" ? "レビュー方式" : value === "parallel" ? "並列方式" : value.replaceAll("_", " ");
}

function taskTypeLabel(value: string) {
  return ({ bug_fix: "不具合修正", documentation: "ドキュメント", feature: "機能追加", investigation: "調査", refactor: "リファクタリング", security_review: "セキュリティレビュー" } as Record<string, string>)[value] ?? value;
}

function validationStepLabel(value: string) {
  return ({ npm_test: "テスト", npm_lint: "Lint", npm_typecheck: "型チェック", npm_build: "ビルド" } as Record<string, string>)[value] ?? value.replace("npm_", "");
}

function missingScriptLabel(value: string) {
  return value === "skip" ? "スキップ" : value === "fail" ? "失敗" : value;
}

function timeoutLabel(value: string) {
  return value === "standard" ? "標準" : value === "extended" ? "延長" : value;
}

function TaskDetail({ task, tab, onTab, onDelete, onRun, onCheckDependencies, dependencyCheck, dependencyCheckLoading, busy }: { task: RepoTask; tab: "overview" | "changes" | "history" | "technical"; onTab: (tab: "overview" | "changes" | "history" | "technical") => void; onDelete: () => void; onRun: () => void; onCheckDependencies: () => void; dependencyCheck: DependencyReadinessCheck | null; dependencyCheckLoading: boolean; busy: boolean }) {
  const readOnly = ["security_review", "investigation"].includes(task.template.taskType);
  const dependencyRecovery = dependencyRecoveryPresentation(task.dependencyRecovery);
  const retryReview = task.status === "draft" && task.flowStatus === "error";
  const progress = task.flowSteps.map((step) => `${step.status === "completed" ? "✓" : step.status === "running" ? "→" : "○"} ${labels[step.agent]} ${roleLabels[step.role]}`);
  return <section className="taskDetail card" aria-labelledby="task-detail-title"><div className="cardHeader"><div><span className="eyebrow">タスク</span><h2 id="task-detail-title">{displayTaskPrompt(task.prompt)}</h2></div><Status domain="task" value={task.status} /></div>
    {readOnly ? <p className="readOnlyNotice"><strong>{templateNameLabel(task.template.name)} · 閲覧専用</strong><br />作業領域・commit・PRは作成しません。レビュー完了後に指摘を確認できます。</p> : task.autonomous ? <p className="muted">自律実行: 検証失敗時に最大1回だけ修正を試みます。承認は人が行います。</p> : <p className="muted">次の操作: <strong>{task.status === "draft" ? "レビューを開始" : task.status === "awaiting_approval" ? "変更内容を確認" : "安全に続行"}</strong></p>}
    <div className="detailTabs" role="tablist" aria-label="タスク詳細"><button type="button" className={tab === "overview" ? "selected" : "secondary"} onClick={() => onTab("overview")}>概要</button><button type="button" className={tab === "changes" ? "selected" : "secondary"} onClick={() => onTab("changes")}>変更内容</button><button type="button" className={tab === "history" ? "selected" : "secondary"} onClick={() => onTab("history")}>履歴</button><button type="button" className={tab === "technical" ? "selected" : "secondary"} onClick={() => onTab("technical")}>技術情報</button></div>
    {tab === "overview" ? <><div className="progressList">{progress.map((item) => <span key={item}>{item}</span>)}</div>{dependencyRecovery ? <section className="dependencyRecovery" aria-labelledby="dependency-recovery-overview-title"><span className="eyebrow">復旧</span><h3 id="dependency-recovery-overview-title">依存関係の準備が必要</h3><p><strong>最初に確認:</strong> 「依存関係を確認」で、作業ツリーの依存関係が使える状態か判断できます。npm install は実行しません。</p><p className="actionAudience">操作できる人: 人。このブラウザを操作している担当者です。</p>{dependencyCheck ? <DependencyCheckResultView result={dependencyCheck} nextAction={retryReview ? "確認済みなら「レビューを再実行」を押してください。" : "確認済みなら「変更内容」で差分を再確認してください。"} /> : null}<div className="inlineActions"><button type="button" className="secondary" disabled={busy} onClick={onCheckDependencies}>{dependencyCheckLoading ? "確認中…" : "依存関係を確認"}</button><button type="button" className="secondary" disabled={busy} onClick={() => onTab("changes")}>復旧操作を開く</button></div>{retryReview ? <><p className="actionAudience">「確認済み」になった後だけ、レビューを再実行できます。</p><button type="button" disabled={busy || dependencyCheck?.status !== "ready"} onClick={onRun}>{busy ? "開始中…" : "レビューを再実行"}</button></> : null}</section> : null}{task.status === "draft" && !dependencyRecovery ? <button type="button" disabled={busy} onClick={onRun}>{busy ? "開始中…" : "タスクを開始"}</button> : null}{!readOnly && task.status === "awaiting_approval" ? <button type="button" onClick={() => onTab("changes")}>変更内容を確認</button> : null}{readOnly && task.flowStatus === "completed" ? <button type="button" onClick={() => document.getElementById("findings-title")?.scrollIntoView()}>指摘を表示</button> : null}</> : null}
    {tab === "technical" ? <details open><summary>技術情報</summary><p>リポジトリ: {task.repoName} · ブランチ: <code>{task.branch}</code> · プロファイル: {task.profile.name} v{task.profile.version} · タスク種類: {templateNameLabel(task.template.name)} v{task.template.version}</p><p>内部状態: {taskStatusLabel(task.status)} · 復旧状態: {recoveryLabel(task.recoveryStatus)} · 作業領域: {worktreeLabel(task.worktreeStatus)}</p><p className="actionAudience">この削除操作は人だけが実行できます。commit済みの作業領域は削除できません。</p><button type="button" className="danger" onClick={onDelete} disabled={busy || Boolean(task.commitSha) || !task.worktreeAvailable}>タスクの作業領域を削除</button></details> : null}
  </section>;
}

function DependencyCheckResultView({ result, nextAction }: { result: DependencyReadinessCheck; nextAction: string }) {
  const label = result.status === "ready" ? "確認済み" : result.status === "missing" ? "未準備" : "確認エラー";
  const statusClass = result.status === "ready" ? "pass" : result.status === "missing" ? "fail" : "unknown";
  const checkedAt = new Date(result.checkedAt).toLocaleString("ja-JP");
  return <div className="dependencyCheckResult" role="status"><p><strong>判定:</strong> <span className={`status ${statusClass}`}>{label}</span> {result.message}</p><p><strong>次:</strong> {nextAction}</p><small>確認時刻: {checkedAt}</small></div>;
}

function displayTaskPrompt(value: string) {
  const parts = value.split(/User task:\s*/i).slice(1);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = parts[index].split(/\s+Autonomous repair iteration\b/i)[0].trim();
    if (candidate && !candidate.startsWith("Server-defined task template instructions:")) return candidate;
  }
  return value.replace(/^Server-defined task template instructions:\s*/i, "").split(/\s+Autonomous repair iteration\b/i)[0].trim() || value;
}

function FindingsPanel({ task, templates, findings, busy, onFindings, onOpenTask, onHistoryRefresh, onDashboardRefresh, onError }: {
  task: RepoTask;
  templates: TaskTemplate[];
  findings: FindingDetail[];
  busy: boolean;
  onFindings: (findings: FindingDetail[]) => void;
  onOpenTask: (taskId: string) => void;
  onHistoryRefresh: () => void;
  onDashboardRefresh: () => void;
  onError: (error: string) => void;
}) {
  const safeTemplates = templates.filter((template) => template.enabled && ["bug_fix", "feature", "refactor"].includes(template.templateId));
  const [processing, setProcessing] = useState("");
  const [conversion, setConversion] = useState<Finding | null>(null);
  const [conversionTemplate, setConversionTemplate] = useState("bug_fix");
  const [objective, setObjective] = useState("");
  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, HumanPriority>>({});
  const [notice, setNotice] = useState("");

  async function extract() {
    setProcessing("extract"); onError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}/findings/extract`, "finding-extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      const data = await response.json() as { findings?: FindingDetail[]; error?: string };
      if (!response.ok || !data.findings) throw new Error(data.error || "Finding extraction failed");
      onFindings(data.findings); onHistoryRefresh(); setNotice("指摘を抽出しました。");
    } catch (error) { onError(message(error)); }
    finally { setProcessing(""); }
  }

  async function changeStatus(finding: Finding, action: "accept" | "dismiss") {
    let reason: string | undefined;
    if (action === "dismiss") {
      const answer = window.prompt("Optional dismissal reason (キャンセル keeps the finding open):", "");
      if (answer === null) return;
      reason = answer;
    }
    setProcessing(finding.findingId); onError("");
    try {
      const response = await humanMutationFetch(`/api/findings/${finding.findingId}/${action}`, `finding-${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "accept" ? { confirmed: true } : { confirmed: true, reason }),
      });
      const data = await response.json() as { finding?: Finding; remediation?: RemediationQueueItem; history?: FindingEvent[]; error?: string };
      if (!response.ok || !data.finding) throw new Error(data.error || `Finding ${action} failed`);
      onFindings(findings.map((item) => item.findingId === data.finding!.findingId ? { ...data.finding!, remediation: data.remediation, history: data.history } : item)); onHistoryRefresh(); setNotice(action === "accept" ? "指摘を受け入れました。" : "指摘を対象外にしました。");
    } catch (error) { onError(message(error)); }
    finally { setProcessing(""); }
  }

  function openConversion(finding: Finding) {
    const initialTemplate = safeTemplates.find((template) => template.templateId === "bug_fix")?.templateId ?? safeTemplates[0]?.templateId ?? "";
    setConversionTemplate(initialTemplate);
    setObjective("Fix the confirmed issue described in the reviewed finding.");
    setConversion(finding);
  }

  async function convert() {
    if (!conversion) return;
    setProcessing(conversion.findingId); onError("");
    try {
      const response = await humanMutationFetch(`/api/findings/${conversion.findingId}/convert`, "finding-convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, templateId: conversionTemplate, objective }),
      });
      const data = await response.json() as { finding?: Finding; task?: RepoTask; remediation?: RemediationQueueItem; history?: FindingEvent[]; error?: string };
      if (!response.ok || !data.finding || !data.task) throw new Error(data.error || "Finding conversion failed");
      onFindings(findings.map((item) => item.findingId === data.finding!.findingId ? { ...data.finding!, remediation: data.remediation, history: data.history } : item));
      setConversion(null); onHistoryRefresh(); onDashboardRefresh(); setNotice("実装タスクを作成しました。");
    } catch (error) { onError(message(error)); }
    finally { setProcessing(""); }
  }

  async function savePriority(finding: FindingDetail) {
    const priority = priorityDrafts[finding.findingId] ?? finding.humanPriority;
    setProcessing(finding.findingId); onError("");
    try {
      const response = await humanMutationFetch(`/api/findings/${finding.findingId}/priority`, "finding-priority", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, priority }),
      });
      const data = await response.json() as { finding?: Finding; remediation?: RemediationQueueItem; history?: FindingEvent[]; error?: string };
      if (!response.ok || !data.finding) throw new Error(data.error || "Finding priority update failed");
      onFindings(findings.map((item) => item.findingId === finding.findingId ? { ...data.finding!, remediation: data.remediation, history: data.history } : item));
      onDashboardRefresh(); setNotice("優先度を更新しました。");
    } catch (error) { onError(message(error)); }
    finally { setProcessing(""); }
  }

  async function resolveFinding(finding: FindingDetail) {
    if (!window.confirm("Mark this finding resolved after its merged PR?")) return;
    setProcessing(finding.findingId); onError("");
    try {
      const response = await humanMutationFetch(`/api/findings/${finding.findingId}/resolve`, "finding-resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const data = await response.json() as { finding?: Finding; remediation?: RemediationQueueItem; history?: FindingEvent[]; error?: string };
      if (!response.ok || !data.finding) throw new Error(data.error || "指摘を解決済みにできませんでした。");
      onFindings(findings.map((item) => item.findingId === finding.findingId ? { ...data.finding!, remediation: data.remediation, history: data.history } : item));
      onDashboardRefresh(); setNotice("指摘を解決済みにしました。");
    } catch (error) { onError(message(error)); }
    finally { setProcessing(""); }
  }

  return <section className="card findings" aria-labelledby="findings-title">
    <div className="cardHeader"><div><span className="eyebrow">信頼しないレビュー出力</span><h2 id="findings-title">指摘</h2></div>{findings.length === 0 ? <button type="button" disabled={busy || Boolean(processing) || task.flowStatus !== "completed" || !task.finalOutput} onClick={() => void extract()}>{processing === "extract" ? "抽出中…" : "指摘を抽出"}</button> : <span>{findings.length}件</span>}</div>
    <p className="actionAudience">操作できる人: 人。レビュー結果の抽出・受け入れ・対象外・実装タスク作成は担当者が確認して行います。</p>{notice ? <p className="actionResult actionResult-success" role="status">{notice}</p> : null}
    <p className="muted">指摘の本文は信頼しない入力として扱います。抽出だけでは実装タスクを作成せず、下の確認操作が必要です。</p>
    {findings.length ? <div className="findingList">{findings.map((finding) => <article className="findingItem" key={finding.findingId}>
      <div className="findingHeading"><Status domain="finding_severity" value={finding.severity} /><h3>{finding.title}</h3><span className={`findingStatus ${finding.status}`}>{finding.status.toUpperCase()}</span></div>
      <p>{finding.summary}</p>
      {finding.category ? <p><strong>分類:</strong> {finding.category}</p> : null}
      {finding.affectedPaths?.length ? <div><strong>影響しそうなパス:</strong><ul>{finding.affectedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div> : null}
      {finding.evidence ? <details><summary>根拠</summary><pre>{finding.evidence}</pre></details> : null}
      <div className="findingRemediation">
        <label>担当者の優先度<select value={priorityDrafts[finding.findingId] ?? finding.humanPriority} disabled={busy || Boolean(processing) || Boolean(finding.resolvedAt)} onChange={(event) => setPriorityDrafts((current) => ({ ...current, [finding.findingId]: event.target.value as HumanPriority }))}>{humanPriorities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <button type="button" className="secondary compactButton" disabled={busy || Boolean(processing) || (priorityDrafts[finding.findingId] ?? finding.humanPriority) === finding.humanPriority || Boolean(finding.resolvedAt)} onClick={() => void savePriority(finding)}>優先度を保存</button>
        {finding.remediation ? <dl><div><dt>対応段階</dt><dd>{finding.remediation.remediationStage}</dd></div><div><dt>次の操作</dt><dd>{finding.remediation.nextAction}</dd></div><div><dt>関連タスク</dt><dd>{finding.remediation.implementationTaskId ? <code>{finding.remediation.implementationTaskId}</code> : "未作成"}</dd></div><div><dt>関連PR</dt><dd>{finding.remediation.prNumber ? `#${finding.remediation.prNumber} · ${finding.remediation.prState || "保存済み"}` : "なし"}</dd></div></dl> : null}
      </div>
      <div className="findingActions">
        {finding.status === "open" ? <><button type="button" disabled={busy || Boolean(processing)} onClick={() => void changeStatus(finding, "accept")}>受け入れる</button><button type="button" className="secondary" disabled={busy || Boolean(processing)} onClick={() => void changeStatus(finding, "dismiss")}>対象外にする</button></> : null}
        {["open", "accepted"].includes(finding.status) ? <button type="button" disabled={busy || Boolean(processing) || safeTemplates.length === 0} onClick={() => openConversion(finding)}>実装タスクを作成</button> : null}
        {finding.convertedTaskId ? <button type="button" className="secondary" onClick={() => onOpenTask(finding.convertedTaskId!)}>実装タスクを開く</button> : null}
        {finding.remediation?.nextAction === "mark_resolved" ? <button type="button" disabled={busy || Boolean(processing)} onClick={() => void resolveFinding(finding)}>解決済みにする</button> : null}
      </div>
      {finding.history?.length ? <details className="findingHistory"><summary>指摘の履歴（{finding.history.length}件）</summary><ol>{finding.history.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleString()}</time> · {event.type} · {event.actor}{event.previousHumanPriority && event.humanPriority ? ` · ${event.previousHumanPriority} → ${event.humanPriority}` : ""}</li>)}</ol></details> : null}
    </article>)}</div> : <p className="muted">読み取り専用のレビューを完了してから、指摘を抽出してください。</p>}
    {conversion ? <div className="dialogBackdrop" role="presentation"><section className="cleanupDialog conversionDialog" role="dialog" aria-modal="true" aria-labelledby="conversion-title"><span className="eyebrow">担当者の確認が必要</span><h2 id="conversion-title">実装タスクを作成しますか？</h2><dl><div><dt>指摘</dt><dd>{conversion.title}</dd></div><div><dt>重大度</dt><dd>{conversion.severity}</dd></div><div><dt>リポジトリ</dt><dd>{task.repoName}</dd></div></dl><label>使用するテンプレート<select value={conversionTemplate} onChange={(event) => setConversionTemplate(event.target.value)}>{safeTemplates.map((template) => <option key={template.templateId} value={template.templateId}>{template.name}</option>)}</select></label><label>担当者が承認した目的<textarea rows={4} maxLength={20_000} value={objective} onChange={(event) => setObjective(event.target.value)} /></label><p>同じリポジトリに隔離された新しいタスクを作成します。指摘本文は信頼しない入力として扱い、プロジェクト設定を再確認します。</p><p className="actionAudience">操作できる人: 人。この確認を行った担当者です。</p><div className="dialogActions"><button type="button" className="secondary" disabled={Boolean(processing)} onClick={() => setConversion(null)}>キャンセル</button><button type="button" disabled={Boolean(processing) || !conversionTemplate || !objective.trim()} onClick={() => void convert()}>{processing ? "作成中…" : "タスクを作成"}</button></div></section></div> : null}
  </section>;
}

type ProfilePanelProps = { repoId: string; profile: ProjectProfile; disabled: boolean; onSaved: (profile: ProjectProfile) => void; onError: (error: string) => void };
type TemplateData = { templates: TaskTemplate[]; settings: RepoTemplateSettings };

function TemplatePanel({ repo, selectedTemplateId, disabled, onSelected, onSaved, onError }: { repo: Repo; selectedTemplateId: string; disabled: boolean; onSelected: (id: string) => void; onSaved: (data: TemplateData) => void; onError: (error: string) => void }) {
  const [saving, setSaving] = useState("");
  const selected = repo.templates.find((template) => template.templateId === selectedTemplateId) ?? repo.templates.find((template) => template.enabled);

  async function save(input: { templateId?: string; enabled?: boolean; defaultTemplateId?: string }, key: string) {
    setSaving(key); onError("");
    try {
      const response = await humanMutationFetch(`/api/repos/${encodeURIComponent(repo.id)}/templates`, "template-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: true, ...input }),
      });
      const data = await response.json() as TemplateData & { error?: string };
      if (!response.ok) throw new Error(data.error || "タスクの種類の設定更新に失敗しました。");
      onSaved(data);
    } catch (error) { onError(message(error)); }
    finally { setSaving(""); }
  }

  return <section className="templatePanel" aria-labelledby="task-templates-title">
    <div className="profileHeading"><div><span className="eyebrow">プロジェクト設定</span><h3 id="task-templates-title">タスクの種類</h3></div><label>既定の種類<select disabled={disabled || Boolean(saving)} value={repo.settings.defaultTemplateId} onChange={(event) => void save({ defaultTemplateId: event.target.value }, "default")}>{repo.templates.filter((template) => template.enabled).map((template) => <option key={template.templateId} value={template.templateId}>{templateNameLabel(template.name)}</option>)}</select></label></div>
    <p className="actionAudience">操作できる人: 人。種類の有効化と既定値の変更だけができます。実行ルールはサーバー側で固定されています。</p>
    <label htmlFor="task-template">タスクの種類</label>
    <select id="task-template" value={selected?.templateId || ""} disabled={disabled} onChange={(event) => onSelected(event.target.value)}>{repo.templates.filter((template) => template.enabled).map((template) => <option key={template.templateId} value={template.templateId}>{templateNameLabel(template.name)}</option>)}</select>
    {selected ? <div className="templateSummary"><div><strong>{templateNameLabel(selected.name)} v{selected.version}</strong><p>{templateDescriptionLabel(selected.description)}</p><p>{taskTypeLabel(selected.taskType)} · {executionModeLabel(selected.executionMode)}</p></div><div><strong>検証</strong><p>{selected.validationPreset.length ? selected.validationPreset.map((step) => `✓ ${validationStepLabel(step)}`).join(" · ") : "読み取り専用・検証コマンドなし"}</p></div><div><strong>実行</strong><p>{(["codex", "cursor", "claude"] as const).map((agent) => `${labels[agent]} ${executionRoleLabel(selected.roles[agent])}`).join(" · ")}</p><p>{selected.requireHumanApproval ? "担当者の承認が必要 · " : ""}{selected.requirePr ? "PRを作成" : "commit・push・PRなし"}</p></div></div> : null}
    <details className="templateManagement"><summary>組み込みの種類を管理</summary><p className="muted">変更できるのは有効・無効と既定値だけです。定義とプロンプトの先頭文はサーバー側で管理します。</p><div className="templateList">{repo.templates.map((template) => <div key={template.templateId}><span><strong>{templateNameLabel(template.name)}</strong> <small>v{template.version} · {template.enabled ? "有効" : "無効"}</small></span><button type="button" className="secondary" disabled={disabled || Boolean(saving) || (template.enabled && repo.settings.defaultTemplateId === template.templateId)} onClick={() => void save({ templateId: template.templateId, enabled: !template.enabled }, template.templateId)}>{saving === template.templateId ? "保存中…" : template.enabled ? "無効にする" : "有効にする"}</button></div>)}</div></details>
  </section>;
}

function ProfilePanel(props: ProfilePanelProps) {
  return <ProfilePanelContent key={`${props.repoId}-${props.profile.profileId}-${props.profile.version}`} {...props} />;
}

function ProfilePanelContent({ repoId, profile, onSaved, onError }: ProfilePanelProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(profile.name);
  const [enabled, setEnabled] = useState(profile.enabled);
  const [roles, setRoles] = useState<RolePolicy>(profile.roles);
  const [validation, setValidation] = useState<ValidationPolicy>(profile.validation);

  function toggleStep(step: ValidationStep) {
    setValidation((current) => ({ ...current, steps: current.steps.includes(step) ? current.steps.filter((item) => item !== step) : validationSteps.filter((item) => current.steps.includes(item) || item === step) }));
  }

  async function saveProfile() {
    if (!window.confirm(`Save ${name} as the human-managed profile for this repository? Existing tasks will keep their snapshots.`)) return;
    setSaving(true); onError("");
    try {
      const response = await humanMutationFetch(`/api/repos/${encodeURIComponent(repoId)}/profile`, "profile-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: true, name, enabled, roles, validation }),
      });
      const data = await response.json() as { profile?: ProjectProfile; error?: string };
      if (!response.ok || !data.profile) throw new Error(data.error || "実行プロファイルの更新に失敗しました。");
      onSaved(data.profile); setEditing(false);
    } catch (error) { onError(message(error)); }
    finally { setSaving(false); }
  }

  return <section className="profilePanel" aria-label="プロジェクト設定">
    <div className="profileHeading"><div><span className="eyebrow">プロジェクト設定</span><h3>実行プロファイル: {profile.name} v{profile.version}</h3></div><button type="button" className="secondary" disabled={saving} onClick={() => setEditing((value) => !value)}>{editing ? "編集をやめる" : "プロファイルを編集"}</button></div>
    <div className="profileSummary">
      <div className="roleGrid">{agentIds.map((id) => <div key={id}><strong>{labels[id]}</strong><span className={`roleBadge ${profile.roles[id]}`}>{executionRoleLabel(profile.roles[id])}</span></div>)}</div>
      <div><strong>検証</strong><p>{profile.validation.steps.map((step) => `✓ ${validationStepLabel(step)}`).join(" · ") || "検証なし"} · 不足スクリプト: {missingScriptLabel(profile.validation.missingScript)} · 制限時間: {timeoutLabel(profile.validation.timeout)}</p></div>
      <div><strong>Gitと安全策</strong><p>✓ 隔離された作業領域 · ✓ 担当者の承認 · ✓ PRが必要 · ✕ アプリ内のマージ・デプロイ · ✕ 強制push</p></div>
    </div>
    {editing ? <div className="profileEditor">
      <label>プロファイル名<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <label className="profileEnabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 新しいタスクで有効</label>
      <fieldset><legend>エージェントの役割</legend><div className="roleEditor">{agentIds.map((id) => <label key={id}>{labels[id]}<select value={roles[id]} onChange={(event) => setRoles((current) => ({ ...current, [id]: event.target.value as RolePolicy[typeof id] }))}>{agentRoles.filter((role) => id === "codex" || role !== "implement").map((role) => <option key={role} value={role}>{executionRoleLabel(role)}</option>)}</select></label>)}</div></fieldset>
      <fieldset><legend>検証の許可リスト</legend><div className="validationEditor">{validationSteps.map((step) => <label key={step}><input type="checkbox" checked={validation.steps.includes(step)} onChange={() => toggleStep(step)} /> {step.replace("npm_", "npm ")}</label>)}</div></fieldset>
      <div className="profileOptions"><label>スクリプト不足時<select value={validation.missingScript} onChange={(event) => setValidation((current) => ({ ...current, missingScript: event.target.value as ValidationPolicy["missingScript"] }))}><option value="skip">スキップ</option><option value="fail">失敗</option></select></label><label>制限時間<select value={validation.timeout} onChange={(event) => setValidation((current) => ({ ...current, timeout: event.target.value as ValidationPolicy["timeout"] }))}><option value="standard">標準</option><option value="extended">延長</option></select></label></div>
      <p className="muted">Git、承認、整理、マージ、デプロイ、強制pushの安全策はサーバー側で固定され、緩和できません。</p>
      <p className="actionAudience">保存できる人: 人。このブラウザを操作している担当者です。</p><button type="button" disabled={saving || !name} onClick={() => void saveProfile()}>{saving ? "保存中…" : "プロファイルを保存"}</button>
    </div> : null}
  </section>;
}

function PrReviewPanel({ task, processing, onFetch, onApply }: { task: RepoTask; processing: boolean; onFetch: () => void; onApply: () => void }) {
  const review = task.prReview;
  const actionable = review?.items.filter((item) => item.disposition === "action_required").length ?? 0;
  const blocking = review?.items.filter((item) => item.disposition === "blocking").length ?? 0;
  const informational = review?.items.filter((item) => item.disposition === "informational").length ?? 0;
  return <section className="card prReview"><div className="cardHeader"><h2>PRレビューの取り込み</h2><button type="button" disabled={processing || ["reworking", "reviewing_rework", "validating", "committing_rework", "pushing_rework", "checking_ci"].includes(task.status)} onClick={onFetch}>{processing ? "処理中…" : review ? "レビューを更新" : "レビューを取得"}</button></div>
    {review && <><h3>プルリクエスト #{review.number}</h3><p><a href={review.url} target="_blank" rel="noreferrer">{review.title}</a></p><div className="prGrid"><span><strong>{review.state}</strong>{review.draft ? " · 下書き" : ""}</span><span>基準ブランチ: <code>{review.base}</code></span><span>作業ブランチ: <code>{review.head}</code></span><span>コミット識別子: <code>{review.headSha.slice(0, 12)}</code></span><span>マージ可否: {review.mergeable} / {review.mergeStateStatus}</span><span>未解決スレッド: {review.unresolvedCount}</span></div>
      <h3>チェック</h3>{review.checks.length ? review.checks.map((check) => <div className="validationRow" key={`${check.name}-${check.state}`}><span>{check.name}{check.required ? "（必須）" : ""}</span><Status domain="pr_check" value={check.bucket} /><span>{checkStateLabel(check.state)}</span></div>) : <p>チェック結果はありません。</p>}
      <h3>変更されたファイル</h3><pre>{review.changedFiles.map((file) => `${file.path}  +${file.additions} -${file.deletions}`).join("\n") || "None."}</pre>
      <h3>レビューと指摘</h3><p>対応が必要: {actionable} · ブロック: {blocking} · 情報: {informational}</p>{review.items.length ? review.items.map((item) => <article className="reviewItem" key={item.id}><div><Status domain="review_disposition" value={item.disposition} /> <strong>{item.author}</strong> · {reviewItemKindLabel(item.kind)}{item.state ? ` · ${reviewItemStateLabel(item.state)}` : ""}{item.path ? <> · <code>{item.path}{item.line ? `:${item.line}` : ""}</code></> : null}</div><p>{item.reason}{item.potentiallyAddressed ? " · 対応済みの可能性があります。GitHubで手動確認してください。" : ""}</p>{item.body && <pre>{item.body}</pre>}</article>) : <p>レビューコメントはありません。</p>}
    </>}
    {task.reviewIntake && <div className="intake"><h3>固定されたレビュー手順</h3>{task.reviewIntake.steps.map((step, index) => <article className="reviewItem" key={step.id}><div><strong>{index + 1}. {labels[step.agent]}</strong> — {step.id.replaceAll("_", " ")} <Status domain="flow" value={step.status} /></div>{step.error && <ErrorBlock error={step.error} />}<pre>{step.output || "出力はありません。"}</pre></article>)}</div>}
    {task.status === "awaiting_rework_approval" && <div className="approval"><p><strong>確認済み・対応可能な指摘:</strong> {actionable + blocking}</p><p>この担当者の承認後にだけ修正を開始します。レビュー本文は信頼しない入力として扱います。</p><button type="button" disabled={processing || !task.originalTaskAvailable || !task.worktreeAvailable} onClick={onApply}>{processing ? "修正を実行中…" : "確認済みの修正を適用"}</button>{(!task.originalTaskAvailable || !task.worktreeAvailable) && <p className="staleReason">再起動後に元のタスク情報または管理対象の作業領域が失われたため、自動修正は無効です。</p>}</div>}
    {task.ciMessage && <p className={task.status === "ci_failed" ? "error" : "staleReason"}>{task.ciMessage}</p>}
    {task.status === "ready_for_human_merge" && <div className="prCreated"><h3>{taskStatusLabel(task.status)}</h3><p>人によるマージ確認が必要です。GitHubでPRを開いてください。</p><p>このアプリはマージ、auto-merge、承認、スレッド解決、ブランチ削除、デプロイを実行していません。</p></div>}
  </section>;
}

function FlowTimeline({ steps, versions, status, finalOutput, sending, activeRerun, rerunAvailable, onRerun }: { steps: FlowStep[]; versions: StepVersion[]; status: ReviewFlowResult["status"] | "idle" | "running"; finalOutput: string; sending: boolean; activeRerun: RerunnableStepId | null; rerunAvailable: boolean; onRerun: (id: RerunnableStepId) => void }) { return <section className="flow" aria-label="レビューの進行状況"><div className="flowTitle"><h2>レビューの進行状況</h2><Status domain="flow" value={status} /></div>{flowStepIds.map((id, index) => { const step = steps.find((item) => item.id === id)!; const stepVersions = versions.filter((item) => item.stepId === id); const rerunnable = canRerunFailedReviewStep(step, rerunAvailable); return <div key={id}><article className={`card flowStep ${step.role === "final" ? "finalStep" : ""}`}><div className="cardHeader"><div><span className="stepNumber">ステップ {index + 1}</span><h2>{labels[step.agent]} — {roleLabels[step.role]}</h2></div><Status domain="flow" value={step.status} /></div><div className="duration">{step.status === "running" ? activeRerun === id ? "再実行中…" : "実行中…" : <>所要時間: {step.durationMs === undefined ? "—" : formatDuration(step.durationMs)}</>}</div>{step.error && (step.status === "stale" ? <div className="staleReason">{step.error}</div> : <ErrorBlock error={step.error} />)}{stepVersions.length > 1 ? <StepVersionViewer key={`${id}-${stepVersions.at(-1)?.version}`} versions={stepVersions} /> : <pre className="output">{step.output || fallback(step.status)}</pre>}{rerunnable && <><p className="actionAudience">操作できる人: 人。結果を確認してから、このステップだけを再実行します。</p><button className="rerun" type="button" disabled={sending} onClick={() => onRerun(id as RerunnableStepId)}>{activeRerun === id ? "再実行中…" : "このステップを再実行"}</button></>}</article>{index < steps.length - 1 && <div className="arrow" aria-hidden="true">↓</div>}</div>; })}{finalOutput && <article className="card finalOutput"><h2>最終結果</h2><pre className="output">{finalOutput}</pre></article>}</section>; }

function StepVersionViewer({ versions }: { versions: StepVersion[] }) {
  const [selected, setSelected] = useState(versions.at(-1)?.version ?? 1);
  const version = versions.find((item) => item.version === selected) ?? versions.at(-1)!;
  return <div className="versionViewer"><label>出力バージョン <select aria-label={`${version.stepId} 出力バージョン`} value={version.version} onChange={(event) => setSelected(Number(event.target.value))}>{versions.map((item) => <option key={item.id} value={item.version}>バージョン {item.version}</option>)}</select></label><div className="versionMeta"><Status domain="flow" value={version.status} /> · {new Date(version.createdAt).toLocaleString()} · {version.durationMs === undefined ? "—" : formatDuration(version.durationMs)}</div><pre className="output">{version.output || fallback(version.status)}</pre></div>;
}

function TaskHistoryPanel({ history }: { history: TaskHistory }) {
  return <section className="card auditTrail" aria-label="タスクの履歴"><div className="cardHeader"><div><span className="stepNumber">追記専用の操作履歴</span><h2>タイムライン</h2></div><span>{history.events.length}件のイベント</span></div>{history.events.length ? <ol className="timeline">{history.events.map((event) => <li key={event.id}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><div><strong>{eventLabel(event)}</strong><span>{actorLabel(event.actor)}{event.stepId ? ` · ${stepLabel(event.stepId)}` : ""}{event.status ? ` · ${historyEventStatusLabel(event.status)}` : ""}</span>{event.metadata && <small>{metadataLabel(event.metadata)}</small>}</div></li>)}</ol> : <p className="muted">操作履歴はまだありません。</p>}{history.diffVersions.length > 0 && <div className="diffHistory"><h3>差分の履歴</h3>{history.diffVersions.map((version) => <div key={version.id}><strong>バージョン {version.version}</strong><span>{version.changedFileCount}ファイル · +{version.additions} −{version.deletions}</span><code>{version.diffHash.slice(0, 12)}</code></div>)}</div>}</section>;
}

const eventLabels: Record<string, string> = {
  task_created: "タスクを作成", flow_started: "レビューを開始", step_started: "ステップを開始", step_completed: "ステップを完了", step_failed: "ステップでエラー", step_rerun: "ステップを再実行", step_stale: "ステップを再確認待ち", flow_completed: "レビューを完了", flow_aborted: "レビューを中断", approval_issued: "承認情報を発行", approval_invalidated: "承認を無効化", approval_accepted: "承認済み", approval_failed: "承認に失敗", validation_started: "検証を開始", validation_passed: "検証に成功", validation_failed: "検証に失敗", diff_generated: "差分を作成", commit_created: "変更を保存", branch_pushed: "ブランチを送信", pr_created: "PRを作成", pr_review_fetched: "PRレビューを取得", rework_started: "修正を開始", rework_completed: "修正を完了", ready_for_human_merge: "人のマージ確認待ち", task_resumed: "タスクを再開", worktree_cleanup_requested: "作業領域の整理を要求", worktree_removed: "作業領域を削除", pr_status_refreshed: "PR状態を更新", task_archived: "タスクをアーカイブ", template_snapshot_created: "タスク設定を保存", finding_created: "指摘を作成", finding_status_changed: "指摘状態を変更", finding_converted: "指摘を実装タスクへ変換", implementation_task_created: "実装タスクを作成", runtime_policy_created: "実行ポリシーを作成", runtime_execution_started: "実行を開始", runtime_execution_completed: "実行を完了", runtime_violation_detected: "実行ポリシー違反を検出", os_sandbox_created: "OS隔離環境を作成", os_sandbox_failed: "OS隔離環境の作成に失敗", os_sandbox_violation: "OS隔離環境違反", os_sandbox_process_cleanup: "実行プロセスを整理",
  profile_snapshot_created: "実行設定を保存", task_template_snapshot_created: "タスク設定を保存", agent_lifecycle_recorded: "エージェントの実行記録を保存",
};

const actorLabels: Record<string, string> = { user: "人", system: "システム", codex: "Codex", cursor: "Cursor", claude: "Claude" };
const stepLabels: Record<string, string> = { codex_draft: "Codex 下書き", cursor_review: "Cursor レビュー", claude_review: "Claude レビュー", codex_final: "Codex 最終確認" };
const metadataKeyLabels: Record<string, string> = { durationMs: "所要時間(ms)", agent: "エージェント", role: "役割", policyClass: "権限区分", runtimePolicyVersion: "権限設定版", sandboxProfile: "隔離環境", capabilityClass: "能力区分", diffHash: "差分識別子", changedFileCount: "変更ファイル数", additions: "追加行", deletions: "削除行", profileId: "設定ID", profileVersion: "設定版", templateId: "テンプレートID", templateVersion: "テンプレート版" };
function RuntimePolicyPanel({ task, runtime }: { task: RepoTask; runtime: RuntimePolicyResponse }) {
  return <section className="card runtimePolicy" aria-labelledby="runtime-policy-title"><div className="cardHeader"><div><span className="eyebrow">サーバー側の権限制御 · v{runtime.runtimePolicyVersion}</span><h2 id="runtime-policy-title">実行ポリシー</h2></div>{runtime.allAgentsReadOnly ? <span className="status completed">すべて読み取り専用</span> : null}</div>
    {runtime.allAgentsReadOnly ? <p><strong>{templateNameLabel(task.template.name)}</strong> · すべてのエージェントが読み取り専用 · 作業領域: 不要</p> : null}
    <div className="runtimePolicyGrid">{runtime.policies.map((policy) => <div key={policy.agent}><strong>{labels[policy.agent]}</strong><span>{policy.role === "review_only" ? "レビューのみ" : policy.role === "implement" ? "実装" : "無効"}</span><span>書き込み: {policy.writeScope === "task_worktree_only" ? "タスクの作業領域のみ" : "拒否"}</span></div>)}</div>
    <div className="runtimePolicyGrid"><div><strong>OSサンドボックス</strong><span>状態: {runtime.osSandbox.status === "enforced" ? "適用中" : "利用不可"}</span><span>ファイルシステム / HOME / proc / tmp: 分離</span></div><div><strong>連携</strong><span>WSLとWindowsマウント: 遮断</span><span>PATH: Linuxのみ</span></div><div><strong>ネットワーク</strong><span>検証: {runtime.osSandbox.validation.validationNetwork === "blocked" ? "遮断" : "確認が必要"}</span><span>エージェント: 制限あり / プロバイダー必須</span></div></div>
    <small>{runtime.networkEnforcementDescription} プロバイダーの認証情報は個別に読み取り専用で接続され、ホストのHOMEは接続されません。</small>
  </section>;
}
function eventLabel(event: TaskEvent) { return eventLabels[event.type] ?? event.type.replaceAll("_", " "); }
function checkStateLabel(value: string) { return ({ success: "成功", pass: "成功", failure: "失敗", fail: "失敗", pending: "確認中", queued: "待機中", completed: "完了" } as Record<string, string>)[value] ?? value; }
function reviewItemKindLabel(value: string) { return ({ review: "レビュー", comment: "コメント", change_request: "変更依頼" } as Record<string, string>)[value] ?? value; }
function reviewItemStateLabel(value: string) { return ({ open: "未対応", resolved: "解決済み", dismissed: "対象外", pending: "確認中" } as Record<string, string>)[value] ?? value; }
function actorLabel(actor: string) { return actorLabels[actor] ?? actor; }
function stepLabel(stepId: string) { return stepLabels[stepId] ?? stepId.replaceAll("_", " "); }
function metadataLabel(metadata: Record<string, string | number>) { return Object.entries(metadata).map(([key, value]) => { const text = String(value); return `${metadataKeyLabels[key] ?? key}: ${text === "[object Object]" ? "詳細あり" : text.length > 16 ? text.slice(0, 12) : text}`; }).join(" · "); }
function Status({ domain, value }: { domain: import("./task-labels").StatusBadgeDomain; value: string }) { return <span className={`status ${value}`}>{statusBadgeLabel(domain, value)}</span>; }
function ErrorBlock({ error }: { error: string }) { return <div className="error" role="alert"><strong>エラー</strong><pre>{error}</pre></div>; }
function fallback(status: string) { return status === "idle" ? "入力待ちです。" : status === "running" ? "応答待ちです…" : status === "skipped" ? "このステップは実行されませんでした。" : "出力はありません。"; }
function formatDuration(ms: number) { return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`; }
function message(error: unknown) { return error instanceof Error ? error.message : "リクエストに失敗しました。"; }
