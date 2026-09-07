"use client";

import { useEffect, useState } from "react";
import { taskBuckets, type DashboardCounts, type DashboardResponse, type DashboardTask, type TaskBucket } from "@/dashboard/types";
import { RemediationQueue } from "./remediation-queue";
import { humanMutationFetch } from "./human-mutation";

type Repo = { id: string; name: string };
type Props = {
  repos: Repo[];
  busy: boolean;
  refreshToken: number;
  onResume: (taskId: string) => void;
  onHistory: (taskId: string, label: string) => void;
  onError: (error: string) => void;
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
  const [view, setView] = useState<"tasks" | "findings">("tasks");
  return <section className="dashboardShell">
    <div className="dashboardTabs" role="tablist" aria-label="Operations dashboard">
      <button type="button" role="tab" aria-selected={view === "tasks"} className={view === "tasks" ? "selected" : ""} onClick={() => setView("tasks")}>Tasks</button>
      <button type="button" role="tab" aria-selected={view === "findings"} className={view === "findings" ? "selected" : ""} onClick={() => setView("findings")}>Findings</button>
    </div>
    {view === "tasks" ? <TaskDashboardContent {...props} /> : <RemediationQueue repos={props.repos} busy={props.busy} refreshToken={props.refreshToken} onOpenTask={props.onResume} onHistory={props.onHistory} onError={props.onError} />}
  </section>;
}

function TaskDashboardContent({ repos, busy, refreshToken, onResume, onHistory, onError }: Props) {
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

  return <section className="dashboard" aria-labelledby="dashboard-title">
    <div className="dashboardTitle"><div><span className="eyebrow">Operational task dashboard</span><h2 id="dashboard-title">Tasks</h2></div><button type="button" className="secondary" onClick={() => setRefreshSequence((value) => value + 1)}>Refresh dashboard</button></div>
    <div className="bucketGrid" aria-label="Task buckets">
      {taskBuckets.map((value) => <button type="button" key={value} className={`bucketTile ${bucket === value ? "selected" : ""}`} aria-pressed={bucket === value} onClick={() => { setBucket((current) => current === value ? "" : value); if (value === "archived") setIncludeArchived(true); }}><span>{bucketLabels[value]}</span><strong>{counts[value]}</strong></button>)}
    </div>
    <div className="dashboardFilters">
      <label>Repository<select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">All repositories</option>{repos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Bucket<select value={bucket} onChange={(event) => setBucket(event.target.value as TaskBucket | "")}><option value="">All buckets</option>{taskBuckets.map((value) => <option key={value} value={value}>{bucketLabels[value]}</option>)}</select></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{taskStatuses.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Pull request<select value={pr} onChange={(event) => setPr(event.target.value)}><option value="any">With or without PR</option><option value="with_pr">PR exists</option><option value="without_pr">No PR</option></select></label>
      <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated_desc">Recently updated</option><option value="created_desc">Recently created</option><option value="repo_name">Repository name</option></select></label>
      <label className="searchFilter">Search<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Repo, task summary, branch, PR #" /></label>
      <label className="archiveToggle"><input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); if (!event.target.checked && bucket === "archived") setBucket(""); }} /> Include archived</label>
    </div>
    {loading ? <p className="muted">Loading tasks…</p> : tasks.length ? <div className="dashboardTasks">{tasks.map((task) => <TaskCard key={task.id} task={task} busy={busy || actionTaskId === task.id} onResume={onResume} onHistory={onHistory} onRefreshPr={refreshPr} onCleanup={setCleanupTask} />)}</div> : <p className="emptyDashboard">No tasks match these filters.</p>}
    {cleanupTask ? <div className="dialogBackdrop" role="presentation"><section className="cleanupDialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title"><span className="eyebrow">Safe cleanup</span><h2 id="cleanup-title">Delete managed task worktree?</h2><dl><div><dt>Repository</dt><dd>{cleanupTask.repoName}</dd></div><div><dt>Branch</dt><dd><code>{cleanupTask.branch}</code></dd></div></dl><p>{cleanupTask.cleanup.warning || "The task history will be retained locally."}</p><p>This will not delete the GitHub branch or PR.</p><div className="dialogActions"><button type="button" className="secondary" disabled={Boolean(actionTaskId)} onClick={() => setCleanupTask(null)}>Cancel</button><button type="button" className="danger" disabled={!cleanupTask.cleanup.allowed || Boolean(actionTaskId)} onClick={() => void cleanup(cleanupTask)}>{actionTaskId ? "Deleting…" : "Delete worktree"}</button></div></section></div> : null}
  </section>;
}

function TaskCard({ task, busy, onResume, onHistory, onRefreshPr, onCleanup }: { task: DashboardTask; busy: boolean; onResume: Props["onResume"]; onHistory: Props["onHistory"]; onRefreshPr: (task: DashboardTask) => void; onCleanup: (task: DashboardTask) => void }) {
  return <article className={`dashboardCard bucket-${task.bucket}`}>
    <div className="taskCardTop"><div><span className="repoName">{task.repoName}</span><h3>{task.summary}</h3></div><span className={`bucketBadge ${task.bucket}`}>{bucketLabels[task.bucket]}</span></div>
    <div className="taskState"><code>{task.status}</code>{task.inactive ? <span className="inactiveBadge">INACTIVE · {relativeTime(task.updatedAt)}</span> : null}</div>
    <dl className="taskFacts"><div><dt>Profile</dt><dd>{task.profileName} v{task.profileVersion}</dd></div><div><dt>Template</dt><dd>{task.templateName} v{task.templateVersion}</dd></div><div><dt>Branch</dt><dd><code>{task.branch}</code></dd></div><div><dt>Base</dt><dd>{baseLabel(task)}</dd></div><div><dt>PR</dt><dd>{task.prNumber ? `#${task.prNumber}${task.prState ? ` · ${task.prState}` : ""}` : "None"}</dd></div><div><dt>Recovery</dt><dd>{task.recoveryStatus}</dd></div><div><dt>Worktree</dt><dd>{task.worktreeInventoryStatus || task.worktreeStatus}{task.worktreeDirty === true ? " · dirty" : ""}</dd></div><div><dt>Size / age</dt><dd>{task.worktreeSizeBytes === undefined ? "—" : `${formatBytes(task.worktreeSizeBytes)} · ${Math.floor(task.worktreeAgeHours || 0)}h`}</dd></div><div><dt>Cleanup</dt><dd>{task.cleanupCandidate ? "Candidate" : "Retain"}</dd></div><div><dt>Updated</dt><dd>{relativeTime(task.updatedAt)}</dd></div></dl>
    {task.source ? <div className="taskSource"><strong>Source</strong><p>Finding {task.source.severity.toUpperCase()} — {task.source.title}</p></div> : null}
    {task.attentionReason ? <div className="attentionReason"><strong>Reason</strong><p>{task.attentionReason}</p></div> : null}
    <div className="nextAction"><span>Next</span><strong>{task.nextActionLabel}</strong></div>
    <div className="taskCardActions">
      <button type="button" disabled={busy || !task.canResume} onClick={() => onResume(task.id)}>Resume</button>
      <button type="button" className="secondary" disabled={busy || !task.canViewDiff} title={task.canViewDiff ? "Open current diff" : "Diff unavailable without a recoverable worktree"} onClick={() => onResume(task.id)}>Diff</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => onHistory(task.id, `${task.repoName} — ${task.summary}`)}>History</button>
      {task.prUrl ? <a className="buttonLink" href={task.prUrl} target="_blank" rel="noreferrer">Open PR</a> : null}
      {task.canRefreshPr ? <button type="button" className="secondary" disabled={busy} onClick={() => void onRefreshPr(task)}>Refresh PR status</button> : null}
      <button type="button" className="cleanupButton" disabled={busy || !task.cleanup.allowed} title={task.cleanup.blockedReason} onClick={() => onCleanup(task)}>Cleanup</button>
    </div>
    {task.cleanup.blockedReason ? <small className="cleanupBlocked">{task.cleanup.blockedReason}</small> : null}
  </article>;
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
