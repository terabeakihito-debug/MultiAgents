"use client";

import { useEffect, useState, type ReactNode } from "react";
import { taskBuckets, type DashboardCounts, type DashboardResponse, type DashboardTask, type TaskBucket } from "@/dashboard/types";
import { RemediationQueue } from "./remediation-queue";
import { humanMutationFetch } from "./human-mutation";
import { OperationalHealthPanel } from "./operational-health";

type Repo = { id: string; name: string };
type Props = {
  repos: Repo[];
  busy: boolean;
  refreshToken: number;
  view: "tasks" | "findings" | "operations" | "settings";
  onViewChange: (view: "tasks" | "findings" | "operations" | "settings") => void;
  onResume: (taskId: string) => void;
  onHistory: (taskId: string, label: string) => void;
  onError: (error: string) => void;
  settings?: ReactNode;
  startTask?: ReactNode;
};

const bucketLabels: Record<TaskBucket, string> = {
  active: "Active",
  needs_attention: "Needs Attention",
  ready_for_approval: "Ready for Approval",
  pr_open: "PR Open",
  ready_for_human_merge: "Ready for Human Merge",
  archived: "Archived",
};
const emptyCounts = (): DashboardCounts => ({ active: 0, needs_attention: 0, ready_for_approval: 0, pr_open: 0, ready_for_human_merge: 0, archived: 0 });
const taskStatuses = [
  "draft", "reviewed", "awaiting_approval", "validating", "committing", "pushing", "creating_pr", "pr_created",
  "fetching_review", "review_ready", "awaiting_rework_approval", "reworking", "reviewing_rework", "awaiting_final_approval",
  "committing_rework", "pushing_rework", "checking_ci", "ready_for_human_merge", "review_fetch_failed", "rework_failed",
  "ci_failed", "ci_pending", "validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed", "push_failed",
  "pr_failed", "archived",
] as const;

export function TaskDashboard(props: Props) {
  const { view, onViewChange } = props;
  return <section className="dashboardShell">
    <nav className="dashboardTabs" aria-label="Primary navigation">
      <button id="tasks-tab" type="button" role="tab" aria-selected={view === "tasks"} aria-controls="tasks-view" className={view === "tasks" ? "selected" : ""} onClick={() => onViewChange("tasks")}>Tasks</button>
      <button id="findings-tab" type="button" role="tab" aria-selected={view === "findings"} aria-controls="findings-view" className={view === "findings" ? "selected" : ""} onClick={() => onViewChange("findings")}>Findings</button>
      <button id="operations-tab" type="button" role="tab" aria-selected={view === "operations"} aria-controls="operations-view" className={view === "operations" ? "selected" : ""} onClick={() => onViewChange("operations")}>Operations</button>
      <button id="settings-tab" type="button" role="tab" aria-selected={view === "settings"} aria-controls="settings-view" className={view === "settings" ? "selected" : ""} onClick={() => onViewChange("settings")}>Settings</button>
    </nav>
    {view === "tasks" ? <div id="tasks-view" role="tabpanel" aria-labelledby="tasks-tab"><TaskDashboardContent {...props} /></div> : view === "findings" ? <div id="findings-view" role="tabpanel" aria-labelledby="findings-tab"><RemediationQueue repos={props.repos} busy={props.busy} refreshToken={props.refreshToken} onOpenTask={props.onResume} onHistory={props.onHistory} onError={props.onError} /></div> : view === "operations" ? <div id="operations-view" role="tabpanel" aria-labelledby="operations-tab"><OperationalHealthPanel onOpenTask={props.onResume} /></div> : <div id="settings-view" role="tabpanel" aria-labelledby="settings-tab">{props.settings}</div>}
  </section>;
}

function TaskDashboardContent({ repos, busy, refreshToken, onResume, onHistory, onError, startTask }: Props) {
  const [tasks, setTasks] = useState<DashboardTask[]>([]);
  const [counts, setCounts] = useState<DashboardCounts>(emptyCounts);
  const [bucket, setBucket] = useState<TaskBucket | "">("");
  const [repo, setRepo] = useState("");
  const [status, setStatus] = useState("");
  const [pr, setPr] = useState("any");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated_desc");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [cleanupTask, setCleanupTask] = useState<DashboardTask | null>(null);
  const [reassociation, setReassociation] = useState<{ task: DashboardTask; preview: { oldPath: string; candidatePath: string; branch: string; head: string; prNumber?: number; fingerprint: string } } | null>(null);
  const [actionTaskId, setActionTaskId] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ sort, pr, limit: "100" });
      if (bucket) query.set("bucket", bucket);
      if (repo) query.set("repo", repo);
      if (status) query.set("status", status);
      if (search.trim()) query.set("search", search.trim());
      if (includeArchived) query.set("includeArchived", "true");
      setLoading(true);
      void fetch(`/api/dashboard/tasks?${query}`, { signal: controller.signal }).then(async (response) => {
        const data = await response.json() as DashboardResponse & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not load dashboard");
        setTasks(data.tasks); setCounts(data.counts);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) onError(error instanceof Error ? error.message : "Could not load dashboard");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [bucket, includeArchived, onError, pr, refreshSequence, refreshToken, repo, search, sort, status]);

  async function refreshPr(task: DashboardTask) {
    setActionTaskId(task.id);
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}/refresh-pr`, "task-refresh-pr", { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "PR status refresh failed");
      setRefreshSequence((value) => value + 1);
    } catch (error) { onError(error instanceof Error ? error.message : "PR status refresh failed"); }
    finally { setActionTaskId(""); }
  }

  async function cleanup(task: DashboardTask) {
    setActionTaskId(task.id);
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}`, "task-delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmedPrCleanup: Boolean(task.prNumber) }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || "Cleanup failed");
      }
      setCleanupTask(null);
      setRefreshSequence((value) => value + 1);
    } catch (error) { onError(error instanceof Error ? error.message : "Cleanup failed"); }
    finally { setActionTaskId(""); }
  }
  async function previewReassociation(task: DashboardTask) {
    setActionTaskId(task.id);
    try {
      const response = await humanMutationFetch(`/api/tasks/${task.id}/reassociate/preview`, "task-reassociation-preview", { method: "POST" });
      const data = await response.json() as { preview?: { oldPath: string; candidatePath: string; branch: string; head: string; prNumber?: number; fingerprint: string }; error?: string };
      if (!response.ok || !data.preview) throw new Error(data.error || "No safe reassociation candidate was found");
      setReassociation({ task, preview: data.preview });
    } catch (error) { onError(error instanceof Error ? error.message : "Reassociation preview failed"); }
    finally { setActionTaskId(""); }
  }
  async function confirmReassociation() {
    if (!reassociation) return; setActionTaskId(reassociation.task.id);
    try {
      const response = await humanMutationFetch(`/api/tasks/${reassociation.task.id}/reassociate`, "task-reassociation-confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, fingerprint: reassociation.preview.fingerprint }) });
      const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Reassociation failed");
      setReassociation(null); setRefreshSequence((value) => value + 1);
    } catch (error) { onError(error instanceof Error ? error.message : "Reassociation failed"); }
    finally { setActionTaskId(""); }
  }

  const attentionTasks = tasks.filter((task) => task.bucket === "needs_attention" || task.bucket === "ready_for_approval").slice(0, 5);
  const recentTasks = tasks.slice(0, 5);
  const [allTasks, setAllTasks] = useState(false);

  return <section className="dashboard" aria-labelledby="dashboard-title">
    <div className="tasksPageTitle"><div><span className="eyebrow">Workspace</span><h2 id="dashboard-title">Tasks</h2><p>Start work, review changes, and follow up safely.</p></div><button type="button" className="refreshButton" onClick={() => setRefreshSequence((value) => value + 1)}>Refresh</button></div>
    {startTask}
    {!loading && attentionTasks.length > 0 ? <section className="taskSection attentionSection" aria-labelledby="attention-title"><div className="sectionHeading"><div><h2 id="attention-title">Needs your attention</h2><p>Only tasks waiting for a human decision or recovery.</p></div>{counts.needs_attention + counts.ready_for_approval > 5 ? <button type="button" className="secondary" onClick={() => setAllTasks(true)}>View all attention tasks</button> : null}</div><div className="attentionCards">{attentionTasks.map((task) => <TaskCard key={task.id} task={task} busy={busy || actionTaskId === task.id} onResume={onResume} onHistory={onHistory} onRefreshPr={refreshPr} onCleanup={setCleanupTask} onReassociate={previewReassociation} attention />)}</div></section> : null}
    <section className="taskSection recentSection" aria-labelledby="recent-title"><div className="sectionHeading"><div><h2 id="recent-title">Recent tasks</h2><p>{loading ? "Loading tasks…" : "Your five most recently updated tasks."}</p></div><button type="button" className="secondary" onClick={() => setAllTasks((value) => !value)}>{allTasks ? "Show recent" : "View all tasks"}</button></div>
    {!allTasks ? (loading ? null : recentTasks.length ? <div className="recentList">{recentTasks.map((task) => <RecentTaskRow key={task.id} task={task} onOpen={onResume} />)}</div> : <section className="readyToStart"><h3>Ready to start</h3><p>Create a task above when you are ready.</p></section>) : <><details className="dashboardFilters" open><summary>Search and filter all tasks</summary><div className="dashboardFiltersInner">
      <label>Repository<select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">All repositories</option>{repos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Bucket<select value={bucket} onChange={(event) => setBucket(event.target.value as TaskBucket | "")}><option value="">All buckets</option>{taskBuckets.map((value) => <option key={value} value={value}>{bucketLabels[value]}</option>)}</select></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{taskStatuses.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Pull request<select value={pr} onChange={(event) => setPr(event.target.value)}><option value="any">With or without PR</option><option value="with_pr">PR exists</option><option value="without_pr">No PR</option></select></label>
      <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated_desc">Recently updated</option><option value="created_desc">Recently created</option><option value="repo_name">Repository name</option></select></label>
      <label className="searchFilter">Search<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Repo, task summary, branch, PR #" /></label>
      <label className="archiveToggle"><input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); if (!event.target.checked && bucket === "archived") setBucket(""); }} /> Include archived</label>
    </div></details>{loading ? <p className="muted">Loading tasks…</p> : <div className="allTasksList">{tasks.map((task) => <RecentTaskRow key={task.id} task={task} onOpen={onResume} />)}</div>}</>}</section>
    {cleanupTask ? <div className="dialogBackdrop" role="presentation"><section className="cleanupDialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title"><span className="eyebrow">Safe cleanup</span><h2 id="cleanup-title">Delete managed task worktree?</h2><dl><div><dt>Repository</dt><dd>{cleanupTask.repoName}</dd></div><div><dt>Branch</dt><dd><code>{cleanupTask.branch}</code></dd></div></dl><p>{cleanupTask.cleanup.warning || "The task history will be retained locally."}</p><p>This will not delete the GitHub branch or PR.</p><div className="dialogActions"><button type="button" className="secondary" disabled={Boolean(actionTaskId)} onClick={() => setCleanupTask(null)}>Cancel</button><button type="button" className="danger" disabled={!cleanupTask.cleanup.allowed || Boolean(actionTaskId)} onClick={() => void cleanup(cleanupTask)}>{actionTaskId ? "Deleting…" : "Delete worktree"}</button></div></section></div> : null}
    {reassociation ? <div className="dialogBackdrop" role="presentation"><section className="cleanupDialog" role="dialog" aria-modal="true" aria-labelledby="reassociate-title"><span className="eyebrow">Human-confirmed recovery</span><h2 id="reassociate-title">Reassociate managed worktree?</h2><dl><div><dt>Logical repository</dt><dd>{reassociation.task.repoName}</dd></div><div><dt>Old path</dt><dd><code>{reassociation.preview.oldPath}</code></dd></div><div><dt>Candidate</dt><dd><code>{reassociation.preview.candidatePath}</code></dd></div><div><dt>Branch / head</dt><dd><code>{reassociation.preview.branch}</code> · <code>{reassociation.preview.head}</code></dd></div><div><dt>PR</dt><dd>#{reassociation.preview.prNumber}</dd></div></dl><p>This changes only the verified local clone/worktree association. It does not modify the pull request, branch, or commit.</p><div className="dialogActions"><button type="button" className="secondary" disabled={Boolean(actionTaskId)} onClick={() => setReassociation(null)}>Cancel</button><button type="button" disabled={Boolean(actionTaskId)} onClick={() => void confirmReassociation()}>Confirm reassociation</button></div></section></div> : null}
  </section>;
}

function TaskCard({ task, busy, onResume, onHistory, onRefreshPr, onCleanup, onReassociate, attention = false }: { task: DashboardTask; busy: boolean; onResume: Props["onResume"]; onHistory: Props["onHistory"]; onRefreshPr: (task: DashboardTask) => void; onCleanup: (task: DashboardTask) => void; onReassociate: (task: DashboardTask) => void; attention?: boolean }) {
  return <article className={`dashboardCard bucket-${task.bucket}`}>
    <div className="taskCardTop"><div><h3>{task.summary}</h3><p className="taskCardMeta">{task.repoName} · {task.templateName}</p></div></div>
    <div className="taskState"><span className={`status ${task.status}`}>{task.nextActionLabel || task.status.replaceAll("_", " ")}</span></div>
    <p className="nextActionExplanation">{actionExplanation(task)}</p>
    {attention ? <div className="taskCardActions"><button type="button" disabled={busy || !task.canResume} onClick={() => onResume(task.id)}>{task.nextActionLabel || "Open task"}</button>{task.worktreeStatus === "missing" ? <button type="button" className="secondary" disabled={busy} onClick={() => onReassociate(task)}>Review reassociation candidate</button> : null}</div> : null}
    <details className="cardDetails"><summary>Details</summary><div>{task.attentionReason ? <p>{task.attentionReason}</p> : null}<button type="button" className="secondary" disabled={busy} onClick={() => onHistory(task.id, `${task.repoName} — ${task.summary}`)}>History</button>{task.prUrl ? <a className="buttonLink" href={task.prUrl} target="_blank" rel="noreferrer">Open PR</a> : null}{task.canRefreshPr ? <button type="button" className="secondary" disabled={busy} onClick={() => void onRefreshPr(task)}>Refresh PR status</button> : null}<p>Branch: <code>{task.branch}</code> · Profile: {task.profileName} v{task.profileVersion}</p><button type="button" className="cleanupButton" disabled={busy || !task.cleanup.allowed} title={task.cleanup.blockedReason} onClick={() => onCleanup(task)}>Cleanup worktree</button></div></details>
    {task.cleanup.blockedReason ? <small className="cleanupBlocked">{task.cleanup.blockedReason}</small> : null}
  </article>;
}

function RecentTaskRow({ task, onOpen }: { task: DashboardTask; onOpen: Props["onResume"] }) {
  return <article className="recentTaskRow"><div><button type="button" className="taskTitleLink" onClick={() => onOpen(task.id)}>{task.summary}</button><p>{task.repoName} · {task.templateName}</p></div><span className={`status ${task.status}`}>{task.status.replaceAll("_", " ")}</span><time>{relativeTime(task.updatedAt)}</time><button type="button" className="secondary compactOpen" onClick={() => onOpen(task.id)}>Open</button></article>;
}

function actionExplanation(task: DashboardTask) {
  if (task.bucket === "ready_for_approval") return "Changes are ready for your review.";
  if (task.recoveryStatus !== "recoverable") return "This task needs a safe recovery decision.";
  if (task.status === "pr_created") return "The pull request is open and ready for follow-up.";
  return "Open the task to take the next safe action.";
}

function relativeTime(value: string) {
  const elapsed = Date.now() - Date.parse(value);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  return `${Math.floor(elapsed / 86_400_000)} days ago`;
}

function baseLabel(task: DashboardTask) {
  if (task.baseState === "base_advanced") return `Advanced by ${task.baseAheadCount ?? "?"} commits`;
  return task.baseState?.replace("base_", "") || "unchecked";
}
function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}
