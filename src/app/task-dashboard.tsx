"use client";

import { useEffect, useState, type ReactNode } from "react";
import { taskBuckets, type DashboardCounts, type DashboardResponse, type DashboardTask, type TaskBucket } from "@/dashboard/types";
import { RemediationQueue } from "./remediation-queue";
import { humanMutationFetch } from "./human-mutation";
import { OperationalHealthPanel } from "./operational-health";
import { attentionPresentation, recoveryLabel, taskBucketLabels, taskStatusFilterOptions, taskStatusLabel, templateNameLabel, worktreeLabel } from "./task-labels";

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

const emptyCounts = (): DashboardCounts => ({ active: 0, needs_attention: 0, ready_for_approval: 0, pr_open: 0, ready_for_human_merge: 0, archived: 0 });

export function TaskDashboard(props: Props) {
  const { view, onViewChange } = props;
  return <section className="dashboardShell">
    <nav className="dashboardTabs" aria-label="メインナビゲーション">
      <button id="tasks-tab" type="button" role="tab" aria-selected={view === "tasks"} aria-controls="tasks-view" className={view === "tasks" ? "selected" : ""} onClick={() => onViewChange("tasks")}>タスク</button>
      <button id="findings-tab" type="button" role="tab" aria-selected={view === "findings"} aria-controls="findings-view" className={view === "findings" ? "selected" : ""} onClick={() => onViewChange("findings")}>指摘</button>
      <button id="operations-tab" type="button" role="tab" aria-selected={view === "operations"} aria-controls="operations-view" className={view === "operations" ? "selected" : ""} onClick={() => onViewChange("operations")}>運用状況</button>
      <button id="settings-tab" type="button" role="tab" aria-selected={view === "settings"} aria-controls="settings-view" className={view === "settings" ? "selected" : ""} onClick={() => onViewChange("settings")}>設定</button>
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
  const [notice, setNotice] = useState("");

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
      setNotice("PRの状態を更新しました。");
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
      setNotice("作業領域を整理しました。");
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
      setNotice("復旧候補を表示しました。");
    } catch (error) { onError(error instanceof Error ? error.message : "Reassociation preview failed"); }
    finally { setActionTaskId(""); }
  }
  async function confirmReassociation() {
    if (!reassociation) return; setActionTaskId(reassociation.task.id);
    try {
      const response = await humanMutationFetch(`/api/tasks/${reassociation.task.id}/reassociate`, "task-reassociation-confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, fingerprint: reassociation.preview.fingerprint }) });
      const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Reassociation failed");
      setReassociation(null); setRefreshSequence((value) => value + 1);
      setNotice("作業領域を再関連付けしました。");
    } catch (error) { onError(error instanceof Error ? error.message : "Reassociation failed"); }
    finally { setActionTaskId(""); }
  }

  const attentionTasks = tasks.filter((task) => task.bucket === "needs_attention" || task.bucket === "ready_for_approval").slice(0, 5);
  const recentTasks = tasks.slice(0, 5);
  const [allTasks, setAllTasks] = useState(false);

  return <section className="dashboard" aria-labelledby="dashboard-title">
    <div className="tasksPageTitle"><div><span className="eyebrow">作業スペース</span><h2 id="dashboard-title">タスク</h2><p>作業を開始し、変更を確認し、安全に続行します。</p></div><div className="inlineActions">{notice ? <p className="actionResult actionResult-success" role="status">{notice}</p> : null}<button type="button" className="refreshButton" onClick={() => { setRefreshSequence((value) => value + 1); setNotice("タスク一覧を更新しました。"); }}>更新</button></div></div>
    {startTask}
    {!loading && attentionTasks.length > 0 ? <section className="taskSection attentionSection" aria-labelledby="attention-title"><div className="sectionHeading"><div><h2 id="attention-title">対応が必要なタスク</h2><p>確認や復旧が必要なタスクです。</p></div>{counts.needs_attention + counts.ready_for_approval > 5 ? <button type="button" className="secondary" onClick={() => setAllTasks(true)}>すべて表示</button> : null}</div><div className="attentionCards">{attentionTasks.map((task) => <TaskCard key={task.id} task={task} busy={busy || actionTaskId === task.id} onResume={onResume} onHistory={onHistory} onRefreshPr={refreshPr} onCleanup={setCleanupTask} onReassociate={previewReassociation} attention />)}</div></section> : null}
    <section className="taskSection recentSection" aria-labelledby="recent-title"><div className="sectionHeading"><div><h2 id="recent-title">最近のタスク</h2><p>{loading ? "タスクを読み込んでいます…" : "最近更新された5件のタスクです。"}</p></div><button type="button" className="secondary" onClick={() => setAllTasks((value) => !value)}>{allTasks ? "最近の表示に戻す" : "すべてのタスクを表示"}</button></div>
    {!allTasks ? (loading ? null : recentTasks.length ? <div className="recentList">{recentTasks.map((task) => <RecentTaskRow key={task.id} task={task} onOpen={onResume} />)}</div> : <section className="readyToStart"><h3>準備完了</h3><p>上でタスクを作成すると、ここに表示されます。</p></section>) : <><details className="dashboardFilters" open><summary>タスクを検索・絞り込み</summary><div className="dashboardFiltersInner">
      <label>リポジトリ<select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">すべてのリポジトリ</option>{repos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>状態<select value={bucket} onChange={(event) => setBucket(event.target.value as TaskBucket | "")}><option value="">すべての状態</option>{taskBuckets.map((value) => <option key={value} value={value}>{taskBucketLabels[value]}</option>)}</select></label>
      <label>タスクの状態<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">すべてのタスク状態</option>{taskStatusFilterOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>プルリクエスト<select value={pr} onChange={(event) => setPr(event.target.value)}><option value="any">PRあり・なし</option><option value="with_pr">PRあり</option><option value="without_pr">PRなし</option></select></label>
      <label>並び順<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated_desc">更新が新しい順</option><option value="created_desc">作成が新しい順</option><option value="repo_name">リポジトリ名順</option></select></label>
      <label className="searchFilter">検索<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="リポジトリ名、タスク、ブランチ、PR番号" /></label>
      <label className="archiveToggle"><input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); if (!event.target.checked && bucket === "archived") setBucket(""); }} /> アーカイブ済みを含める</label>
    </div></details>{loading ? <p className="muted">タスクを読み込んでいます…</p> : <div className="allTasksList">{tasks.map((task) => <RecentTaskRow key={task.id} task={task} onOpen={onResume} />)}</div>}</>}</section>
    {cleanupTask ? <div className="dialogBackdrop" role="presentation"><section className="cleanupDialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title"><span className="eyebrow">安全な整理</span><h2 id="cleanup-title">管理対象の作業領域を削除しますか？</h2><dl><div><dt>リポジトリ</dt><dd>{cleanupTask.repoName}</dd></div><div><dt>ブランチ</dt><dd><code>{cleanupTask.branch}</code></dd></div></dl><p>{cleanupTask.cleanup.warning || "タスクの履歴はローカルに残ります。"}</p><p>削除直前に安全性を再確認します。GitHubのブランチやPRは削除しません。</p><p className="actionAudience">操作できる人: 人。このブラウザを操作している担当者です。</p><div className="dialogActions"><button type="button" className="secondary" disabled={Boolean(actionTaskId)} onClick={() => setCleanupTask(null)}>キャンセル</button><button type="button" className="danger" disabled={!cleanupTask.cleanup.allowed || Boolean(actionTaskId)} onClick={() => void cleanup(cleanupTask)}>{actionTaskId ? "削除中…" : "作業領域を削除"}</button></div></section></div> : null}
    {reassociation ? <div className="dialogBackdrop" role="presentation"><section className="cleanupDialog" role="dialog" aria-modal="true" aria-labelledby="reassociate-title"><span className="eyebrow">人が確認する復旧</span><h2 id="reassociate-title">管理対象の作業領域を再関連付けしますか？</h2><dl><div><dt>論理リポジトリ</dt><dd>{reassociation.task.repoName}</dd></div><div><dt>以前のパス</dt><dd><code>{reassociation.preview.oldPath}</code></dd></div><div><dt>候補</dt><dd><code>{reassociation.preview.candidatePath}</code></dd></div><div><dt>ブランチ / HEAD</dt><dd><code>{reassociation.preview.branch}</code> · <code>{reassociation.preview.head}</code></dd></div><div><dt>PR</dt><dd>#{reassociation.preview.prNumber}</dd></div></dl><p>確認済みのローカルcloneと作業領域の関連付けだけを変更します。PR、ブランチ、commitは変更しません。</p><p className="actionAudience">操作できる人: 人。このブラウザを操作している担当者です。</p><div className="dialogActions"><button type="button" className="secondary" disabled={Boolean(actionTaskId)} onClick={() => setReassociation(null)}>キャンセル</button><button type="button" disabled={Boolean(actionTaskId)} onClick={() => void confirmReassociation()}>再関連付けを確定</button></div></section></div> : null}
  </section>;
}

function TaskCard({ task, busy, onResume, onHistory, onRefreshPr, onCleanup, onReassociate, attention = false }: { task: DashboardTask; busy: boolean; onResume: Props["onResume"]; onHistory: Props["onHistory"]; onRefreshPr: (task: DashboardTask) => void; onCleanup: (task: DashboardTask) => void; onReassociate: (task: DashboardTask) => void; attention?: boolean }) {
  const presentation = attentionPresentation({ ...task, canReassociate: task.worktreeStatus === "missing" });
  return <article className={`dashboardCard bucket-${task.bucket}`}>
    <div className="taskCardTop"><div><h3>{displayTaskText(task.summary)}</h3><p className="taskCardMeta">{task.repoName} · {templateNameLabel(task.templateName)}</p></div></div>
    <div className="taskState"><span className={`status ${task.status}`}>{presentation.label}</span></div>
    <p className="nextActionExplanation">{presentation.explanation}</p>
    {attention ? <div className="taskCardActions"><button type="button" disabled={busy || !task.canResume} onClick={() => onResume(task.id)}>タスクを開く</button>{presentation.action === "reassociate" ? <button type="button" className="secondary" disabled={busy} onClick={() => onReassociate(task)}>復旧候補を確認</button> : null}{presentation.action === "refresh_pr" ? <button type="button" className="secondary" disabled={busy} onClick={() => void onRefreshPr(task)}>PRの状態を更新</button> : null}</div> : null}
    <details className="cardDetails"><summary>詳細</summary><div><p>復旧状況: {recoveryLabel(task.recoveryStatus)} · {worktreeLabel(task.worktreeStatus)}</p>{task.recoveryMessage || task.attentionReason ? <p>診断情報: {task.recoveryMessage ?? task.attentionReason}</p> : null}<button type="button" className="secondary" disabled={busy} onClick={() => onHistory(task.id, `${task.repoName} — ${task.summary}`)}>履歴</button>{task.prUrl ? <a className="buttonLink" href={task.prUrl} target="_blank" rel="noreferrer">PRを開く</a> : null}{task.canRefreshPr ? <button type="button" className="secondary" disabled={busy} onClick={() => void onRefreshPr(task)}>PRの状態を更新</button> : null}<p>ブランチ: <code>{task.branch}</code> · プロファイル: {task.profileName} v{task.profileVersion}</p><button type="button" className="cleanupButton" disabled={busy || !task.cleanup.allowed} title={task.cleanup.blockedReason} onClick={() => onCleanup(task)}>作業領域を整理</button></div></details>
    {task.cleanup.blockedReason ? <small className="cleanupBlocked">{task.cleanup.blockedReason}</small> : null}
  </article>;
}

function RecentTaskRow({ task, onOpen }: { task: DashboardTask; onOpen: Props["onResume"] }) {
  return <article className="recentTaskRow"><div><button type="button" className="taskTitleLink" onClick={() => onOpen(task.id)}>{displayTaskText(task.summary)}</button><p>{task.repoName} · {templateNameLabel(task.templateName)}</p></div><span className={`status ${task.status}`}>{taskStatusLabel(task.status)}</span><time>{relativeTime(task.updatedAt)}</time><button type="button" className="secondary compactOpen" onClick={() => onOpen(task.id)}>開く</button></article>;
}

function displayTaskText(value: string) {
  const parts = value.split(/User task:\s*/i).slice(1);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = parts[index].split(/\s+Autonomous repair iteration\b/i)[0].trim();
    if (candidate && !candidate.startsWith("Server-defined task template instructions:")) return candidate;
  }
  return value.replace(/^Server-defined task template instructions:\s*/i, "").split(/\s+Autonomous repair iteration\b/i)[0].trim() || value;
}

function relativeTime(value: string) {
  const elapsed = Date.now() - Date.parse(value);
  if (elapsed < 60_000) return "たった今";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}時間前`;
  return `${Math.floor(elapsed / 86_400_000)}日前`;
}
