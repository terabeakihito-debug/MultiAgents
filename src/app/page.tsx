"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { agentIds, flowStepIds, rerunnableStepIds, type AgentId, type AgentResult, type AgentStatus, type FlowEvent, type FlowStep, type RerunnableStepId, type ReviewFlowResult, type ReviewRerunEvent } from "@/agents/types";
import { FlowEventParser } from "@/flows/sse";
import { acquireRunLock, releaseRunLock } from "./run-lock";
import { TaskDashboard } from "./task-dashboard";
import { NotificationCenter } from "./notification-center";
import { CredentialStatusPanel } from "./credential-status";
import { agentRoles, validationSteps, type ProjectProfile, type ProjectProfileSnapshot, type RolePolicy, type ValidationPolicy, type ValidationStep } from "@/profiles/policy";
import type { RepoTemplateSettings, TaskTemplate, TaskTemplateSnapshot } from "@/templates/policy";
import { humanPriorities, type Finding, type FindingEvent, type HumanPriority, type RemediationQueueItem } from "@/findings/types";
import type { PublicRuntimePolicy, RuntimeViolationRecord } from "@/runtime/types";
import { humanMutationFetch } from "./human-mutation";

const labels: Record<AgentId, string> = { codex: "Codex", cursor: "Cursor", claude: "Claude" };
const roleLabels = { draft: "Draft", review: "Review", final: "Final" } as const;
type Mode = "parallel" | "review";
type CardState = { status: AgentStatus; output: string; error?: string };
type Repo = { id: string; name: string; branch: string; dirty: boolean; profile: ProjectProfile; templates: TaskTemplate[]; settings: RepoTemplateSettings };
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
  prReview?: PrReview; reviewIntake?: PrIntake; originalTaskAvailable: boolean; worktreeAvailable: boolean; latestPushedSha?: string; ciMessage?: string; error?: string;
  prompt: string; createdAt: string; updatedAt: string; flowId?: string; flowStatus?: string; flowSteps: FlowStep[]; finalOutput?: string;
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
  const [cards, setCards] = useState(initialCards);
  const [steps, setSteps] = useState(initialSteps);
  const [flowStatus, setFlowStatus] = useState<ReviewFlowResult["status"] | "idle" | "running">("idle");
  const [finalOutput, setFinalOutput] = useState("");
  const [activeRerun, setActiveRerun] = useState<RerunnableStepId | null>(null);
  const [sending, setSending] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [openPulls, setOpenPulls] = useState<OpenPull[]>([]);
  const [task, setTask] = useState<RepoTask | null>(null);
  const [dashboardRefresh, setDashboardRefresh] = useState(0);
  const [taskDiff, setTaskDiff] = useState<TaskDiff | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [reviewedDiff, setReviewedDiff] = useState(false);
  const [approvalProcessing, setApprovalProcessing] = useState(false);
  const [reviewProcessing, setReviewProcessing] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [taskHistory, setTaskHistory] = useState<TaskHistory>(emptyHistory);
  const [historyTitle, setHistoryTitle] = useState("");
  const [findings, setFindings] = useState<FindingDetail[]>([]);
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicyResponse | null>(null);
  const sendingRef = useRef(false);
  const flowAbortRef = useRef<AbortController | null>(null);

  useEffect(() => { void fetch("/api/repos").then(async (response) => {
    const data = await response.json() as { repos?: Repo[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Could not load repositories");
    setRepos(data.repos || []);
    setRepoId((current) => current || data.repos?.[0]?.id || "");
    setTemplateId((current) => current || data.repos?.[0]?.settings.defaultTemplateId || "");
  }).catch((error) => setTaskError(message(error))); }, []);

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

  async function createIsolatedTask() {
    setTaskError(""); setTaskDiff(null); setApproval(null); setReviewedDiff(false); setOpenPulls([]); setTaskHistory(emptyHistory()); setFindings([]);
    try {
      const response = await humanMutationFetch("/api/tasks", "task-create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoId, templateId, prompt }) });
      const data = await response.json() as { task?: RepoTask; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error || "Task creation failed");
      setTask(data.task); setMode(data.task.template.executionMode === "parallel" ? "parallel" : "review"); await loadTaskHistory(data.task.id); setDashboardRefresh((value) => value + 1);
    } catch (error) { setTaskError(message(error)); }
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

  async function recoverPull(prNumber: number) {
    if (!repoId || reviewProcessing) return;
    setReviewProcessing(true); setTaskError("");
    try {
      const response = await humanMutationFetch("/api/tasks/recover-pr", "task-recover-pr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoId, prNumber }) });
      const data = await response.json() as { task?: RepoTask; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error || "PR task recovery failed");
      setTask(data.task); setMode("review"); setOpenPulls([]); if (data.task.worktreeAvailable) await refreshDiff(data.task); else await loadTaskHistory(data.task.id);
    } catch (error) { setTaskError(message(error)); }
    finally { setReviewProcessing(false); }
  }

  async function refreshDiff(activeTask = task) {
    if (!activeTask) return;
    const response = await humanMutationFetch(`/api/tasks/${activeTask.id}/prepare-approval`, "task-prepare-approval", { method: "POST" });
    const data = await response.json() as { diff?: TaskDiff; task?: RepoTask; approval?: Approval; error?: string };
    if (!data.diff) throw new Error(data.error || "Could not load diff");
    const previousHash = approval?.diffHash;
    const previousApprovalId = approval?.approvalId;
    setTaskDiff(data.diff);
    if (data.task) setTask(data.task);
    setApproval(data.approval ?? null);
    if (!data.approval?.diffHash || data.approval.diffHash !== previousHash || data.approval.approvalId !== previousApprovalId) setReviewedDiff(false);
    await loadTaskHistory(activeTask.id);
    if (!response.ok && data.error) setTaskError(data.error);
  }

  async function deleteWorktree() {
    if (!task) return;
    setTaskError("");
    const response = await humanMutationFetch(`/api/tasks/${task.id}`, "task-delete", { method: "DELETE" });
    if (!response.ok) { const data = await response.json() as { error?: string }; setTaskError(data.error || "Cleanup failed"); return; }
    setTask(null); setTaskDiff(null); setApproval(null); setReviewedDiff(false); setTaskHistory(emptyHistory()); setFindings([]);
    setDashboardRefresh((value) => value + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !acquireRunLock(sendingRef)) return;
    setSending(true);
    try { if (mode === "parallel") await runParallel(); else await runFlow(); }
    finally { releaseRunLock(sendingRef); setSending(false); }
  }

  async function runParallel() {
    setCards(Object.fromEntries(agentIds.map((id) => [id, { status: "running", output: "" }])) as Record<AgentId, CardState>);
    try {
      const response = await humanMutationFetch("/api/agents/parallel", "agent-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
      const data = await response.json() as { results?: AgentResult[]; error?: string };
      if (!response.ok || !data.results || data.results.length !== agentIds.length) throw new Error(data.error || `Request failed (${response.status})`);
      setCards(Object.fromEntries(data.results.map((result) => [result.agent, { status: result.status, output: result.output, error: result.error }])) as Record<AgentId, CardState>);
    } catch (error) {
      setCards(Object.fromEntries(agentIds.map((id) => [id, { status: "error", output: "", error: message(error) }])) as Record<AgentId, CardState>);
    }
  }

  async function runFlow() {
    setFlowStatus("running");
    setSteps(initialSteps());
    setFinalOutput("");
    const abortController = new AbortController();
    flowAbortRef.current = abortController;
    try {
      const response = await humanMutationFetch("/api/flows/review/stream", "review-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, taskId: task?.id }), signal: abortController.signal });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || `Request failed (${response.status})`);
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
      if (task) await refreshDiff(task);
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
        throw new Error(data.error || `Request failed (${response.status})`);
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
  }

  function cancelFlow() { flowAbortRef.current?.abort(new Error("Cancelled by user")); }

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
  const selectedTemplate = selectedRepo?.templates.find((template) => template.templateId === templateId);

  return <main>
    <header className="appHeader"><div><h1>MultiAgents</h1><p>Parallel answers or a fixed, reviewed response from local AI CLIs.</p></div><NotificationCenter repos={repos} refreshToken={dashboardRefresh} onOpenTask={(id) => void resumePersistedTask(id)} onError={setTaskError} /></header>
    <CredentialStatusPanel />
    <TaskDashboard repos={repos} busy={sending || approvalProcessing || reviewProcessing} refreshToken={dashboardRefresh} onResume={(id) => void resumePersistedTask(id)} onHistory={(id, label) => void openDashboardHistory(id, label)} onError={setTaskError} />
    {historyTitle ? <section className="dashboardHistory"><div className="cardHeader"><div><span className="eyebrow">Dashboard history</span><h2>{historyTitle}</h2></div><button type="button" className="secondary" onClick={() => { setHistoryTitle(""); setTaskHistory(emptyHistory()); }}>Close</button></div><TaskHistoryPanel history={taskHistory} /></section> : null}
    <section className="repoPanel"><label htmlFor="repository">Repository</label><div className="repoControls"><select id="repository" value={repoId} disabled={sending || Boolean(task)} onChange={(event) => { const next = repos.find((repo) => repo.id === event.target.value); setRepoId(event.target.value); setTemplateId(next?.settings.defaultTemplateId || ""); setOpenPulls([]); }}>{repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}{repo.dirty ? " (dirty)" : ""}</option>)}</select><button type="button" disabled={!repoId || !selectedTemplate || !prompt.trim() || sending || Boolean(task) || selectedProfile?.enabled === false} onClick={createIsolatedTask}>{selectedTemplate?.readOnly ? "Create read-only task" : "Create isolated task"}</button><button type="button" disabled={!repoId || sending || reviewProcessing || Boolean(task)} onClick={loadOpenPulls}>{reviewProcessing ? "Loading…" : "Find open PRs"}</button></div>{selectedProfile && <ProfilePanel repoId={repoId} profile={selectedProfile} disabled={sending || approvalProcessing || reviewProcessing || Boolean(task)} onSaved={(profile) => { setRepos((current) => current.map((repo) => repo.id === repoId ? { ...repo, profile } : repo)); setDashboardRefresh((value) => value + 1); }} onError={setTaskError} />}{selectedRepo && !task ? <TemplatePanel repo={selectedRepo} selectedTemplateId={templateId} disabled={sending || approvalProcessing || reviewProcessing} onSelected={setTemplateId} onSaved={(data) => { setRepos((current) => current.map((repo) => repo.id === selectedRepo.id ? { ...repo, ...data } : repo)); if (!data.templates.some((template) => template.templateId === templateId && template.enabled)) setTemplateId(data.settings.defaultTemplateId); }} onError={setTaskError} /> : null}{!task && openPulls.length > 0 && <div className="openPulls"><h3>Open PRs from this repository origin</h3>{openPulls.map((pull) => <div className="openPull" key={pull.number}><span>#{pull.number} {pull.title} · <code>{pull.head}</code></span><button type="button" disabled={reviewProcessing} onClick={() => recoverPull(pull.number)}>Open review intake</button></div>)}</div>}{task && <><div className="taskReady"><div><strong>Repo:</strong> {task.repoName}</div><div><strong>Profile:</strong> {task.profile.name} v{task.profile.version}</div><div><strong>Template:</strong> {task.template.name} v{task.template.version}</div><div><strong>Branch:</strong> <code>{task.branch}</code></div><div><strong>State:</strong> <code>{task.status}</code></div><div><strong>Worktree:</strong> {task.worktreeAvailable ? "ready" : task.template.readOnly ? "not required (read-only)" : "unavailable"}</div>{task.sourceFindingId && task.sourceTaskId ? <button type="button" className="secondary" onClick={() => void resumePersistedTask(task.sourceTaskId!)}>Source finding {task.sourceFindingId.slice(0, 8)}</button> : null}<button type="button" className="delete" onClick={deleteWorktree} disabled={sending || approvalProcessing || reviewProcessing || Boolean(task.commitSha) || !task.worktreeAvailable}>Delete task worktree</button></div>{task.recoveryMessage && <p className="staleReason">{task.recoveryMessage}</p>}</>}{taskError && <ErrorBlock error={taskError} />}</section>
    <form onSubmit={submit}>
      <fieldset className="modes" disabled={sending || Boolean(task)}><legend>Mode</legend><label><input type="radio" checked={mode === "parallel"} onChange={() => setMode("parallel")} /> Parallel</label><label><input type="radio" checked={mode === "review"} onChange={() => setMode("review")} /> Review Flow</label></fieldset>
      <label htmlFor="prompt">{task ? "Task" : "Task / Prompt"}</label>
      <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20_000} rows={6} placeholder="Describe the repository task, or ask Codex, Cursor, and Claude…" />
      <div className="actions"><span>{prompt.length.toLocaleString()} / 20,000</span><div className="actionButtons">{sending && mode === "review" && <button className="cancel" type="button" onClick={cancelFlow}>Cancel</button>}<button type="submit" disabled={sending || !prompt.trim() || (mode === "review" && Boolean(task) && !task?.worktreeAvailable && !task?.template.readOnly)}>{sending ? "Running…" : mode === "parallel" ? "Send to all" : "Run review flow"}</button></div></div>
    </form>
    {mode === "parallel" ? <section className="cards" aria-label="Agent responses">{agentIds.map((id) => <AgentCard key={id} name={labels[id]} state={cards[id]} />)}</section> : <FlowTimeline steps={steps} versions={taskHistory.stepVersions} status={flowStatus} finalOutput={finalOutput} sending={sending} activeRerun={activeRerun} rerunAvailable={Boolean(task)} onRerun={rerunStep} />}
    {task && runtimePolicy ? <RuntimePolicyPanel task={task} runtime={runtimePolicy} /> : null}
    {task?.runtimeViolation ? <section className="runtimeViolation" role="alert"><strong>NEEDS ATTENTION</strong><h2>Runtime policy violation</h2><p>{task.runtimeViolation.message}</p><p>Human review is required. No commit, push, approval, or PR action is permitted.</p></section> : null}
    {task && ["security_review", "investigation"].includes(task.template.taskType) ? <FindingsPanel task={task} templates={selectedRepo?.templates ?? []} findings={findings} busy={sending || reviewProcessing} onFindings={setFindings} onOpenTask={(id) => void resumePersistedTask(id)} onHistoryRefresh={() => void loadTaskHistory(task.id)} onDashboardRefresh={() => setDashboardRefresh((value) => value + 1)} onError={setTaskError} /> : null}
    {taskDiff && <section className="diff card"><h2>Final Diff</h2><h3>Tracked changed files</h3><pre>{taskDiff.trackedFiles.join("\n") || "None."}</pre><h3>Untracked files</h3><pre>{taskDiff.untrackedFiles.join("\n") || "None."}</pre><h3>Changed lines</h3><pre>{taskDiff.stat || "No tracked changes."}</pre><details><summary>View full diff</summary><pre>{[taskDiff.patch, taskDiff.untrackedPatch].filter(Boolean).join("\n\n") || "No changes."}</pre></details>{taskDiff.blockedReason && <p className="staleReason">{taskDiff.blockedReason}</p>}
      {(task?.validation.length || approvalProcessing) && <div className="validation"><h3>Pre-PR Validation</h3>{task?.validation.map((check, index) => <div className="validationRow" key={`${check.name}-${index}`}><span>{check.name}</span><Status value={check.status} /><span>{check.detail}</span></div>)}{approvalProcessing && <p>Server-side checks and PR creation are running…</p>}</div>}
      {task?.secretFindings.length ? <div className="error"><strong>Secret scan findings</strong><ul>{task.secretFindings.map((finding, index) => <li key={`${finding.path}-${finding.rule}-${index}`}><code>{finding.path}</code>: {finding.rule}</li>)}</ul></div> : null}
      {approval?.diffHash && approval.approvalId && <div className="approval"><p><strong>Diff hash:</strong> <code>{approval.diffHash}</code></p><label><input type="checkbox" checked={reviewedDiff} disabled={sending || approvalProcessing} onChange={(event) => setReviewedDiff(event.target.checked)} /> {task?.approvalPurpose === "rework" ? "I reviewed the revised final diff" : "I reviewed the final diff"}</label><button type="button" disabled={!reviewedDiff || sending || approvalProcessing} onClick={approveFinalDiff}>{approvalProcessing ? "Validating…" : task?.approvalPurpose === "rework" ? "Approve & Update Existing PR" : "Approve & Create PR"}</button></div>}
      {approval?.blockedReason && <p className="staleReason">{approval.blockedReason}</p>}
      {task?.status === "pr_failed" && <button type="button" className="rerun" disabled={approvalProcessing} onClick={retryPr}>Retry PR creation</button>}
      {task?.status === "pr_created" && task.prUrl && <div className="prCreated"><h3>PR CREATED</h3><p><strong>Branch:</strong> <code>{task.branch}</code></p><p><strong>Commit:</strong> <code>{task.commitSha}</code></p><p><strong>Pull Request:</strong> #{task.prNumber} <a href={task.prUrl} target="_blank" rel="noreferrer">{task.prUrl}</a></p><p>The task worktree is retained. No merge was attempted.</p></div>}
    </section>}
    {task?.prNumber && <PrReviewPanel task={task} processing={reviewProcessing} onFetch={fetchPrReview} onApply={applyReviewFixes} />}
    {task && <TaskHistoryPanel history={taskHistory} />}
  </main>;
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

  async function extract() {
    setProcessing("extract"); onError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}/findings/extract`, "finding-extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      const data = await response.json() as { findings?: FindingDetail[]; error?: string };
      if (!response.ok || !data.findings) throw new Error(data.error || "Finding extraction failed");
      onFindings(data.findings); onHistoryRefresh();
    } catch (error) { onError(message(error)); }
    finally { setProcessing(""); }
  }

  async function changeStatus(finding: Finding, action: "accept" | "dismiss") {
    let reason: string | undefined;
    if (action === "dismiss") {
      const answer = window.prompt("Optional dismissal reason (Cancel keeps the finding open):", "");
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
      onFindings(findings.map((item) => item.findingId === data.finding!.findingId ? { ...data.finding!, remediation: data.remediation, history: data.history } : item)); onHistoryRefresh();
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
      setConversion(null); onHistoryRefresh(); onDashboardRefresh();
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
      onDashboardRefresh();
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
      if (!response.ok || !data.finding) throw new Error(data.error || "Finding resolution failed");
      onFindings(findings.map((item) => item.findingId === finding.findingId ? { ...data.finding!, remediation: data.remediation, history: data.history } : item));
      onDashboardRefresh();
    } catch (error) { onError(message(error)); }
    finally { setProcessing(""); }
  }

  return <section className="card findings" aria-labelledby="findings-title">
    <div className="cardHeader"><div><span className="eyebrow">Untrusted review output</span><h2 id="findings-title">Findings</h2></div>{findings.length === 0 ? <button type="button" disabled={busy || Boolean(processing) || task.flowStatus !== "completed" || !task.finalOutput} onClick={() => void extract()}>{processing === "extract" ? "Extracting…" : "Extract findings"}</button> : <span>{findings.length} findings</span>}</div>
    <p className="muted">Finding content is untrusted. Extraction never creates an implementation task; only the confirmation below can do that.</p>
    {findings.length ? <div className="findingList">{findings.map((finding) => <article className="findingItem" key={finding.findingId}>
      <div className="findingHeading"><Status value={finding.severity} /><h3>{finding.title}</h3><span className={`findingStatus ${finding.status}`}>{finding.status.toUpperCase()}</span></div>
      <p>{finding.summary}</p>
      {finding.category ? <p><strong>Category:</strong> {finding.category}</p> : null}
      {finding.affectedPaths?.length ? <div><strong>Affected (hints):</strong><ul>{finding.affectedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div> : null}
      {finding.evidence ? <details><summary>Evidence</summary><pre>{finding.evidence}</pre></details> : null}
      <div className="findingRemediation">
        <label>Human Priority<select value={priorityDrafts[finding.findingId] ?? finding.humanPriority} disabled={busy || Boolean(processing) || Boolean(finding.resolvedAt)} onChange={(event) => setPriorityDrafts((current) => ({ ...current, [finding.findingId]: event.target.value as HumanPriority }))}>{humanPriorities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <button type="button" className="secondary compactButton" disabled={busy || Boolean(processing) || (priorityDrafts[finding.findingId] ?? finding.humanPriority) === finding.humanPriority || Boolean(finding.resolvedAt)} onClick={() => void savePriority(finding)}>Save priority</button>
        {finding.remediation ? <dl><div><dt>Stage</dt><dd>{finding.remediation.remediationStage}</dd></div><div><dt>Next action</dt><dd>{finding.remediation.nextAction}</dd></div><div><dt>Linked task</dt><dd>{finding.remediation.implementationTaskId ? <code>{finding.remediation.implementationTaskId}</code> : "Not created"}</dd></div><div><dt>Linked PR</dt><dd>{finding.remediation.prNumber ? `#${finding.remediation.prNumber} · ${finding.remediation.prState || "stored"}` : "None"}</dd></div></dl> : null}
      </div>
      <div className="findingActions">
        {finding.status === "open" ? <><button type="button" disabled={busy || Boolean(processing)} onClick={() => void changeStatus(finding, "accept")}>Accept</button><button type="button" className="secondary" disabled={busy || Boolean(processing)} onClick={() => void changeStatus(finding, "dismiss")}>Dismiss</button></> : null}
        {["open", "accepted"].includes(finding.status) ? <button type="button" disabled={busy || Boolean(processing) || safeTemplates.length === 0} onClick={() => openConversion(finding)}>Create implementation task</button> : null}
        {finding.convertedTaskId ? <button type="button" className="secondary" onClick={() => onOpenTask(finding.convertedTaskId!)}>Open implementation task</button> : null}
        {finding.remediation?.nextAction === "mark_resolved" ? <button type="button" disabled={busy || Boolean(processing)} onClick={() => void resolveFinding(finding)}>Mark resolved</button> : null}
      </div>
      {finding.history?.length ? <details className="findingHistory"><summary>Finding history ({finding.history.length})</summary><ol>{finding.history.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleString()}</time> · {event.type} · {event.actor}{event.previousHumanPriority && event.humanPriority ? ` · ${event.previousHumanPriority} → ${event.humanPriority}` : ""}</li>)}</ol></details> : null}
    </article>)}</div> : <p className="muted">Run and complete the read-only review, then explicitly extract structured findings.</p>}
    {conversion ? <div className="dialogBackdrop" role="presentation"><section className="cleanupDialog conversionDialog" role="dialog" aria-modal="true" aria-labelledby="conversion-title"><span className="eyebrow">Human approval required</span><h2 id="conversion-title">Create implementation task?</h2><dl><div><dt>Finding</dt><dd>{conversion.title}</dd></div><div><dt>Severity</dt><dd>{conversion.severity.toUpperCase()}</dd></div><div><dt>Repository</dt><dd>{task.repoName}</dd></div></dl><label>Target template<select value={conversionTemplate} onChange={(event) => setConversionTemplate(event.target.value)}>{safeTemplates.map((template) => <option key={template.templateId} value={template.templateId}>{template.name}</option>)}</select></label><label>Human-approved objective<textarea rows={4} maxLength={20_000} value={objective} onChange={(event) => setObjective(event.target.value)} /></label><p>This creates a new isolated task in the same repository. The finding text is wrapped as untrusted context, and the current project profile is re-evaluated.</p><div className="dialogActions"><button type="button" className="secondary" disabled={Boolean(processing)} onClick={() => setConversion(null)}>Cancel</button><button type="button" disabled={Boolean(processing) || !conversionTemplate || !objective.trim()} onClick={() => void convert()}>{processing ? "Creating…" : "Create task"}</button></div></section></div> : null}
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
      if (!response.ok) throw new Error(data.error || "Task template settings update failed");
      onSaved(data);
    } catch (error) { onError(message(error)); }
    finally { setSaving(""); }
  }

  return <section className="templatePanel" aria-labelledby="task-templates-title">
    <div className="profileHeading"><div><span className="eyebrow">Project Settings</span><h3 id="task-templates-title">Task Templates</h3></div><label>Default template<select disabled={disabled || Boolean(saving)} value={repo.settings.defaultTemplateId} onChange={(event) => void save({ defaultTemplateId: event.target.value }, "default")}>{repo.templates.filter((template) => template.enabled).map((template) => <option key={template.templateId} value={template.templateId}>{template.name}</option>)}</select></label></div>
    <label htmlFor="task-template">Task Template</label>
    <select id="task-template" value={selected?.templateId || ""} disabled={disabled} onChange={(event) => onSelected(event.target.value)}>{repo.templates.filter((template) => template.enabled).map((template) => <option key={template.templateId} value={template.templateId}>{template.name}</option>)}</select>
    {selected ? <div className="templateSummary"><div><strong>{selected.name} v{selected.version}</strong><p>{selected.description}</p><p><code>{selected.taskType}</code> · {selected.executionMode.replaceAll("_", " ")}</p></div><div><strong>Validation</strong><p>{selected.validationPreset.length ? selected.validationPreset.map((step) => `✓ ${step.replace("npm_", "")}`).join(" · ") : "Read-only · no validation commands"}</p></div><div><strong>Execution</strong><p>{(["codex", "cursor", "claude"] as const).map((agent) => `${labels[agent]} ${selected.roles[agent].replace("_", " ")}`).join(" · ")}</p><p>{selected.requireHumanApproval ? "Human approval · " : ""}{selected.requirePr ? "PR required" : "No commit, push, or PR"}</p></div></div> : null}
    <details className="templateManagement"><summary>Manage built-in templates</summary><p className="muted">Only enable/disable and default selection are editable. Definitions and prompt prefixes remain server-controlled.</p><div className="templateList">{repo.templates.map((template) => <div key={template.templateId}><span><strong>{template.name}</strong> <small>v{template.version} · {template.enabled ? "enabled" : "disabled"}</small></span><button type="button" className="secondary" disabled={disabled || Boolean(saving) || (template.enabled && repo.settings.defaultTemplateId === template.templateId)} onClick={() => void save({ templateId: template.templateId, enabled: !template.enabled }, template.templateId)}>{saving === template.templateId ? "Saving…" : template.enabled ? "Disable" : "Enable"}</button></div>)}</div></details>
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
      if (!response.ok || !data.profile) throw new Error(data.error || "Profile update failed");
      onSaved(data.profile); setEditing(false);
    } catch (error) { onError(message(error)); }
    finally { setSaving(false); }
  }

  return <section className="profilePanel" aria-label="Project profile">
    <div className="profileHeading"><div><span className="eyebrow">Project Settings</span><h3>Profile: {profile.name} v{profile.version}</h3></div><button type="button" className="secondary" disabled={saving} onClick={() => setEditing((value) => !value)}>{editing ? "Cancel edit" : "Edit profile"}</button></div>
    <div className="profileSummary">
      <div className="roleGrid">{agentIds.map((id) => <div key={id}><strong>{labels[id]}</strong><span className={`roleBadge ${profile.roles[id]}`}>{profile.roles[id].replace("_", "-")}</span></div>)}</div>
      <div><strong>Validation</strong><p>{profile.validation.steps.map((step) => `✓ ${step.replace("npm_", "")}`).join(" · ") || "No steps"} · missing: {profile.validation.missingScript} · {profile.validation.timeout}</p></div>
      <div><strong>Git & safety</strong><p>✓ isolated worktree · ✓ human approval · ✓ PR required · ✕ merge/deploy in app · ✕ force push</p></div>
    </div>
    {editing ? <div className="profileEditor">
      <label>Profile name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <label className="profileEnabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled for new tasks</label>
      <fieldset><legend>Agent roles</legend><div className="roleEditor">{agentIds.map((id) => <label key={id}>{labels[id]}<select value={roles[id]} onChange={(event) => setRoles((current) => ({ ...current, [id]: event.target.value as RolePolicy[typeof id] }))}>{agentRoles.filter((role) => id === "codex" || role !== "implement").map((role) => <option key={role} value={role}>{role.replace("_", "-")}</option>)}</select></label>)}</div></fieldset>
      <fieldset><legend>Validation allowlist</legend><div className="validationEditor">{validationSteps.map((step) => <label key={step}><input type="checkbox" checked={validation.steps.includes(step)} onChange={() => toggleStep(step)} /> {step.replace("npm_", "npm ")}</label>)}</div></fieldset>
      <div className="profileOptions"><label>Missing script<select value={validation.missingScript} onChange={(event) => setValidation((current) => ({ ...current, missingScript: event.target.value as ValidationPolicy["missingScript"] }))}><option value="skip">skip</option><option value="fail">fail</option></select></label><label>Timeout preset<select value={validation.timeout} onChange={(event) => setValidation((current) => ({ ...current, timeout: event.target.value as ValidationPolicy["timeout"] }))}><option value="standard">standard</option><option value="extended">extended</option></select></label></div>
      <p className="muted">Git, approval, cleanup, merge, deploy, and force-push safety values are server-fixed and cannot be relaxed.</p>
      <button type="button" disabled={saving || !name} onClick={() => void saveProfile()}>{saving ? "Saving…" : "Save profile"}</button>
    </div> : null}
  </section>;
}

function PrReviewPanel({ task, processing, onFetch, onApply }: { task: RepoTask; processing: boolean; onFetch: () => void; onApply: () => void }) {
  const review = task.prReview;
  const actionable = review?.items.filter((item) => item.disposition === "action_required").length ?? 0;
  const blocking = review?.items.filter((item) => item.disposition === "blocking").length ?? 0;
  const informational = review?.items.filter((item) => item.disposition === "informational").length ?? 0;
  return <section className="card prReview"><div className="cardHeader"><h2>PR Review Intake</h2><button type="button" disabled={processing || ["reworking", "reviewing_rework", "validating", "committing_rework", "pushing_rework", "checking_ci"].includes(task.status)} onClick={onFetch}>{processing ? "Working…" : review ? "Refresh review" : "Fetch review"}</button></div>
    {review && <><h3>Pull Request #{review.number}</h3><p><a href={review.url} target="_blank" rel="noreferrer">{review.title}</a></p><div className="prGrid"><span><strong>{review.state}</strong>{review.draft ? " · DRAFT" : ""}</span><span>Base: <code>{review.base}</code></span><span>Head: <code>{review.head}</code></span><span>SHA: <code>{review.headSha.slice(0, 12)}</code></span><span>Mergeable: {review.mergeable} / {review.mergeStateStatus}</span><span>Unresolved threads: {review.unresolvedCount}</span></div>
      <h3>Checks</h3>{review.checks.length ? review.checks.map((check) => <div className="validationRow" key={`${check.name}-${check.state}`}><span>{check.name}{check.required ? " (required)" : ""}</span><Status value={check.bucket} /><span>{check.state}</span></div>) : <p>No checks reported.</p>}
      <h3>Changed files</h3><pre>{review.changedFiles.map((file) => `${file.path}  +${file.additions} -${file.deletions}`).join("\n") || "None."}</pre>
      <h3>Reviews and findings</h3><p>Action required: {actionable} · Blocking: {blocking} · Informational: {informational}</p>{review.items.length ? review.items.map((item) => <article className="reviewItem" key={item.id}><div><Status value={item.disposition} /> <strong>{item.author}</strong> · {item.kind}{item.state ? ` · ${item.state}` : ""}{item.path ? <> · <code>{item.path}{item.line ? `:${item.line}` : ""}</code></> : null}</div><p>{item.reason}{item.potentiallyAddressed ? " · Potentially addressed; resolve manually on GitHub." : ""}</p>{item.body && <pre>{item.body}</pre>}</article>) : <p>No review comments.</p>}
    </>}
    {task.reviewIntake && <div className="intake"><h3>Fixed intake flow</h3>{task.reviewIntake.steps.map((step, index) => <article className="reviewItem" key={step.id}><div><strong>{index + 1}. {labels[step.agent]}</strong> — {step.id.replaceAll("_", " ")} <Status value={step.status} /></div>{step.error && <ErrorBlock error={step.error} />}<pre>{step.output || "No output."}</pre></article>)}</div>}
    {task.status === "awaiting_rework_approval" && <div className="approval"><p><strong>Confirmed/actionable issues:</strong> {actionable + blocking}</p><p>Rework starts only after this human gate. Review text remains untrusted data.</p><button type="button" disabled={processing || !task.originalTaskAvailable || !task.worktreeAvailable} onClick={onApply}>{processing ? "Running rework…" : "Apply reviewed fixes"}</button>{(!task.originalTaskAvailable || !task.worktreeAvailable) && <p className="staleReason">Original task context or the managed worktree was lost after restart; automatic rework is disabled.</p>}</div>}
    {task.ciMessage && <p className={task.status === "ci_failed" ? "error" : "staleReason"}>{task.ciMessage}</p>}
    {task.status === "ready_for_human_merge" && <div className="prCreated"><h3>READY_FOR_HUMAN_MERGE</h3><p>Ready for human merge. Open PR on GitHub.</p><p>No merge, auto-merge, approval, thread resolution, branch deletion, or deploy was attempted.</p></div>}
  </section>;
}

function AgentCard({ name, state }: { name: string; state: CardState }) { return <article className="card"><div className="cardHeader"><h2>{name}</h2><Status value={state.status} /></div>{state.error && <ErrorBlock error={state.error} />}<pre className="output">{state.output || fallback(state.status)}</pre></article>; }
function FlowTimeline({ steps, versions, status, finalOutput, sending, activeRerun, rerunAvailable, onRerun }: { steps: FlowStep[]; versions: StepVersion[]; status: ReviewFlowResult["status"] | "idle" | "running"; finalOutput: string; sending: boolean; activeRerun: RerunnableStepId | null; rerunAvailable: boolean; onRerun: (id: RerunnableStepId) => void }) { return <section className="flow" aria-label="Review flow"><div className="flowTitle"><h2>Review Flow</h2><Status value={status} /></div>{flowStepIds.map((id, index) => { const step = steps.find((item) => item.id === id)!; const stepVersions = versions.filter((item) => item.stepId === id); const rerunnable = rerunAvailable && rerunnableStepIds.includes(id as RerunnableStepId) && ["completed", "stale", "error"].includes(step.status) && Boolean(step.output); return <div key={id}><article className={`card flowStep ${step.role === "final" ? "finalStep" : ""}`}><div className="cardHeader"><div><span className="stepNumber">Step {index + 1}</span><h2>{labels[step.agent]} — {roleLabels[step.role]}</h2></div><Status value={step.status} /></div><div className="duration">{step.status === "running" ? activeRerun === id ? "Re-running..." : "Running..." : <>Duration: {step.durationMs === undefined ? "—" : formatDuration(step.durationMs)}</>}</div>{step.error && (step.status === "stale" ? <div className="staleReason">{step.error}</div> : <ErrorBlock error={step.error} />)}{stepVersions.length > 1 ? <StepVersionViewer key={`${id}-${stepVersions.at(-1)?.version}`} versions={stepVersions} /> : <pre className="output">{step.output || fallback(step.status)}</pre>}{rerunnable && <button className="rerun" type="button" disabled={sending} onClick={() => onRerun(id as RerunnableStepId)}>Re-run</button>}</article>{index < steps.length - 1 && <div className="arrow" aria-hidden="true">↓</div>}</div>; })}{finalOutput && <article className="card finalOutput"><h2>Final Output</h2><pre className="output">{finalOutput}</pre></article>}</section>; }

function StepVersionViewer({ versions }: { versions: StepVersion[] }) {
  const [selected, setSelected] = useState(versions.at(-1)?.version ?? 1);
  const version = versions.find((item) => item.version === selected) ?? versions.at(-1)!;
  return <div className="versionViewer"><label>Output version <select aria-label={`${version.stepId} output version`} value={version.version} onChange={(event) => setSelected(Number(event.target.value))}>{versions.map((item) => <option key={item.id} value={item.version}>Version {item.version}</option>)}</select></label><div className="versionMeta"><Status value={version.status} /> · {new Date(version.createdAt).toLocaleString()} · {version.durationMs === undefined ? "—" : formatDuration(version.durationMs)}</div><pre className="output">{version.output || fallback(version.status)}</pre></div>;
}

function TaskHistoryPanel({ history }: { history: TaskHistory }) {
  return <section className="card auditTrail" aria-label="Task history"><div className="cardHeader"><div><span className="stepNumber">Append-only audit trail</span><h2>Timeline</h2></div><span>{history.events.length} events</span></div>{history.events.length ? <ol className="timeline">{history.events.map((event) => <li key={event.id}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><div><strong>{eventLabel(event)}</strong><span>{event.actor}{event.stepId ? ` · ${event.stepId.replaceAll("_", " ")}` : ""}{event.status ? ` · ${event.status}` : ""}</span>{event.metadata && <small>{metadataLabel(event.metadata)}</small>}</div></li>)}</ol> : <p className="muted">No audit events recorded.</p>}{history.diffVersions.length > 0 && <div className="diffHistory"><h3>Diff versions</h3>{history.diffVersions.map((version) => <div key={version.id}><strong>Version {version.version}</strong><span>{version.changedFileCount} files · +{version.additions} −{version.deletions}</span><code>{version.diffHash.slice(0, 12)}</code></div>)}</div>}</section>;
}

const eventLabels: Record<string, string> = {
  task_created: "Task created", flow_started: "Review flow started", step_started: "Step started", step_completed: "Step completed", step_failed: "Step failed", step_rerun: "Step re-run started", step_stale: "Step marked stale", flow_completed: "Review flow completed", flow_aborted: "Review flow aborted", approval_issued: "Approval issued", approval_invalidated: "Approval invalidated", approval_accepted: "Approval accepted", approval_failed: "Approval failed", validation_started: "Validation started", validation_passed: "Validation passed", validation_failed: "Validation failed", diff_generated: "Diff generated", commit_created: "Commit created", branch_pushed: "Branch pushed", pr_created: "Pull request created", pr_review_fetched: "PR review fetched", rework_started: "Rework started", rework_completed: "Rework completed", ready_for_human_merge: "Ready for human merge", task_resumed: "Task resumed", worktree_cleanup_requested: "Worktree cleanup requested", worktree_removed: "Worktree removed", pr_status_refreshed: "PR status refreshed", task_archived: "Task archived", template_snapshot_created: "Task template snapshot created", finding_created: "Finding created", finding_status_changed: "Finding status changed", finding_converted: "Finding converted", implementation_task_created: "Implementation task created", runtime_policy_created: "Runtime policy created", runtime_execution_started: "Runtime execution started", runtime_execution_completed: "Runtime execution completed", runtime_violation_detected: "Runtime violation detected", os_sandbox_created: "OS sandbox created", os_sandbox_failed: "OS sandbox failed", os_sandbox_violation: "OS sandbox violation", os_sandbox_process_cleanup: "OS sandbox process cleanup",
};

function RuntimePolicyPanel({ task, runtime }: { task: RepoTask; runtime: RuntimePolicyResponse }) {
  return <section className="card runtimePolicy" aria-labelledby="runtime-policy-title"><div className="cardHeader"><div><span className="eyebrow">Server-side capability boundary · v{runtime.runtimePolicyVersion}</span><h2 id="runtime-policy-title">Runtime Policy</h2></div>{runtime.allAgentsReadOnly ? <span className="status completed">ALL READ-ONLY</span> : null}</div>
    {runtime.allAgentsReadOnly ? <p><strong>{task.template.name}</strong> · All agents read-only · Worktree: not required</p> : null}
    <div className="runtimePolicyGrid">{runtime.policies.map((policy) => <div key={policy.agent}><strong>{labels[policy.agent]}</strong><span>{policy.role === "review_only" ? "Review only" : policy.role === "implement" ? "Implement" : "Disabled"}</span><span>Write: {policy.writeScope === "task_worktree_only" ? "task worktree only" : "denied"}</span></div>)}</div>
    <div className="runtimePolicyGrid"><div><strong>OS Sandbox</strong><span>Status: {runtime.osSandbox.status}</span><span>Filesystem / HOME / proc / tmp: isolated</span></div><div><strong>Interop</strong><span>WSL and Windows mounts: blocked</span><span>PATH: Linux only</span></div><div><strong>Network</strong><span>Validation: {runtime.osSandbox.validation.validationNetwork}</span><span>Agents: limited / provider-required</span></div></div>
    <small>{runtime.networkEnforcementDescription} Provider credentials are mounted individually and read-only; general host HOME is not mounted.</small>
  </section>;
}
function eventLabel(event: TaskEvent) { return eventLabels[event.type] ?? event.type.replaceAll("_", " "); }
function metadataLabel(metadata: Record<string, string | number>) { return Object.entries(metadata).map(([key, value]) => `${key}: ${typeof value === "string" && value.length > 16 ? value.slice(0, 12) : value}`).join(" · "); }
function Status({ value }: { value: string }) { return <span className={`status ${value}`}>{value.toUpperCase()}</span>; }
function ErrorBlock({ error }: { error: string }) { return <div className="error"><strong>Error</strong><pre>{error}</pre></div>; }
function fallback(status: string) { return status === "idle" ? "Waiting for a prompt." : status === "running" ? "Waiting for response…" : status === "skipped" ? "This step was not run." : "No output."; }
function formatDuration(ms: number) { return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`; }
function message(error: unknown) { return error instanceof Error ? error.message : "Request failed"; }
