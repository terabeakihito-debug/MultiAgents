"use client";

import { useEffect, useState } from "react";
import {
  findingSeverities,
  findingStatuses,
  humanPriorities,
  remediationStages,
  type HumanPriority,
  type RemediationQueueItem,
  type RemediationQueueResponse,
} from "@/findings/types";
import { humanMutationFetch } from "./human-mutation";

type Repo = { id: string; name: string };
type Props = {
  repos: Repo[];
  busy: boolean;
  refreshToken: number;
  onOpenTask: (taskId: string) => void;
  onHistory: (taskId: string, label: string) => void;
  onError: (error: string) => void;
};

const stageLabels: Record<string, string> = {
  untriaged: "未確認", accepted: "受け入れ済み", implementation_not_created: "実装未作成",
  implementation_active: "実装中", awaiting_approval: "承認待ち", pr_open: "PR公開中",
  ready_for_human_merge: "人のマージ待ち", resolved_candidate: "マージ済み・解決確認待ち",
  resolved: "解決済み", dismissed: "対象外", needs_attention: "対応が必要",
};
const nextLabels: Record<string, string> = {
  review_finding: "指摘を確認", accept_or_dismiss: "受け入れまたは対象外", create_implementation_task: "実装タスクを作成",
  resume_implementation: "実装を再開", review_diff: "差分を確認", open_pr: "PRを開く", fetch_pr_review: "PRの状態を更新",
  human_merge: "人がマージ", mark_resolved: "解決済みにする", manual_recovery: "手動で復旧", none: "操作不要",
};
const severityLabels: Record<string, string> = { critical: "重大", high: "高", medium: "中", low: "低", info: "情報" };
const findingStatusLabels: Record<string, string> = { open: "未対応", accepted: "受け入れ済み", dismissed: "対象外", converted: "実装タスク作成済み" };
const priorityLabels: Record<string, string> = { urgent: "至急", high: "高", normal: "通常", low: "低", none: "設定なし" };

export function RemediationQueue({ repos, busy, refreshToken, onOpenTask, onHistory, onError }: Props) {
  const [data, setData] = useState<RemediationQueueResponse>({ findings: [], counts: { total: 0, critical: 0, high: 0, acceptedNotConverted: 0, needsAttention: 0, readyForMerge: 0 }, limit: 100, offset: 0 });
  const [repo, setRepo] = useState("");
  const [severity, setSeverity] = useState("");
  const [priority, setPriority] = useState("");
  const [status, setStatus] = useState("");
  const [stage, setStage] = useState("");
  const [pr, setPr] = useState("any");
  const [converted, setConverted] = useState("any");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recommended");
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [refreshNotice, setRefreshNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ sort, pr, converted, limit: "100" });
      if (repo) query.set("repo", repo);
      if (severity) query.set("severity", severity);
      if (priority) query.set("priority", priority);
      if (status) query.set("status", status);
      if (stage) query.set("stage", stage);
      if (search.trim()) query.set("search", search.trim());
      if (includeDismissed) query.set("includeDismissed", "true");
      if (includeResolved) query.set("includeResolved", "true");
      setLoading(true);
      void fetch(`/api/findings/queue?${query}`, { signal: controller.signal }).then(async (response) => {
        const result = await response.json() as RemediationQueueResponse & { error?: string };
        if (!response.ok) throw new Error(result.error || "指摘一覧を読み込めませんでした。");
        setData(result); if (refreshSequence > 0) setRefreshNotice("指摘一覧を更新しました。");
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) { setRefreshNotice("指摘一覧を更新できませんでした。"); onError(error instanceof Error ? error.message : "指摘一覧を読み込めませんでした。"); }
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [converted, includeDismissed, includeResolved, onError, pr, priority, refreshSequence, refreshToken, repo, search, severity, sort, stage, status]);

  function refresh() { setRefreshNotice("指摘一覧を更新しています…"); setRefreshSequence((value) => value + 1); }

  return <section className="remediationQueue" aria-labelledby="remediation-queue-title">
    <div className="dashboardTitle"><div><span className="eyebrow">複数リポジトリの指摘</span><h2 id="remediation-queue-title">指摘一覧</h2></div><div className="inlineActions">{refreshNotice ? <p className="actionResult actionResult-success" role="status">{refreshNotice}</p> : null}<button type="button" className="secondary" onClick={refresh}>{loading && refreshSequence > 0 ? "更新中…" : "一覧を更新"}</button></div></div>
    <p className="actionAudience">操作できる人: 人。このブラウザを操作している担当者だけが、指摘の確認・優先度変更・タスク開始を行えます。</p>
    <div className="remediationCounts" aria-label="指摘の概要">
      <span><strong>{data.counts.critical}</strong> 重大</span><span><strong>{data.counts.high}</strong> 高</span>
      <span><strong>{data.counts.acceptedNotConverted}</strong> 受け入れ済み・未実装</span><span><strong>{data.counts.needsAttention}</strong> 対応が必要</span>
      <span><strong>{data.counts.readyForMerge}</strong> マージ待ち</span>
    </div>
    <div className="findingsFilters">
      <label>リポジトリ<select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">すべて</option>{repos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>重大度<select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">すべて</option>{findingSeverities.map((value) => <option key={value} value={value}>{severityLabels[value] ?? value}</option>)}</select></label>
      <label>指摘の状態<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">すべて</option>{findingStatuses.map((value) => <option key={value} value={value}>{findingStatusLabels[value] ?? value}</option>)}</select></label>
      <label>対応段階<select value={stage} onChange={(event) => setStage(event.target.value)}><option value="">すべて</option>{remediationStages.map((value) => <option key={value} value={value}>{stageLabels[value]}</option>)}</select></label>
      <label className="searchFilter">検索<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="指摘・分類・リポジトリ・パス・PR番号" /></label>
      <details className="advancedFindingFilters"><summary>詳細な絞り込み</summary><div>
      <label>人の優先度<select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">すべて</option>{humanPriorities.map((value) => <option key={value} value={value}>{priorityLabels[value] ?? value}</option>)}</select></label>
      <label>プルリクエスト<select value={pr} onChange={(event) => setPr(event.target.value)}><option value="any">PRの有無を問わない</option><option value="yes">PRあり</option><option value="no">PRなし</option></select></label>
      <label>実装タスク<select value={converted} onChange={(event) => setConverted(event.target.value)}><option value="any">作成済み・未作成</option><option value="yes">作成済み</option><option value="no">未作成</option></select></label>
      <label>並び順<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="recommended">おすすめ順</option><option value="severity">重大度順</option><option value="age">古い順</option><option value="updated">更新順</option><option value="repo">リポジトリ順</option></select></label>
      <label className="archiveToggle"><input type="checkbox" checked={includeDismissed} onChange={(event) => setIncludeDismissed(event.target.checked)} /> 対象外も表示</label>
      <label className="archiveToggle"><input type="checkbox" checked={includeResolved} onChange={(event) => setIncludeResolved(event.target.checked)} /> 解決済みも表示</label>
      </div></details></div>
    {loading ? <p className="muted">指摘を読み込んでいます…</p> : data.findings.length ? <div className="queueTableWrap"><table className="queueTable"><thead><tr><th>重大度</th><th>指摘</th><th>リポジトリ</th><th>対応段階</th><th>次の操作</th></tr></thead><tbody>{data.findings.map((finding) => <QueueRow key={`${finding.findingId}-${finding.humanPriority}`} finding={finding} busy={busy} onOpenTask={onOpenTask} onHistory={onHistory} onError={onError} onChanged={refresh} />)}</tbody></table></div> : <p className="emptyDashboard">この条件に一致する指摘はありません。</p>}
  </section>;
}

function QueueRow({ finding, busy, onOpenTask, onHistory, onError, onChanged }: { finding: RemediationQueueItem; busy: boolean; onOpenTask: Props["onOpenTask"]; onHistory: Props["onHistory"]; onError: Props["onError"]; onChanged: () => void }) {
  const [selectedPriority, setSelectedPriority] = useState<HumanPriority>(finding.humanPriority);
  const [processing, setProcessing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");

  async function savePriority() {
    setProcessing(true); onError("");
    try {
      const response = await humanMutationFetch(`/api/findings/${finding.findingId}/priority`, "finding-priority", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, priority: selectedPriority }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "優先度を更新できませんでした。");
      setNotice("優先度を更新しました。"); onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "優先度を更新できませんでした。"); }
    finally { setProcessing(false); }
  }

  async function refreshPr() {
    if (!finding.implementationTaskId) return;
    setProcessing(true); onError("");
    try {
      const response = await humanMutationFetch(`/api/tasks/${finding.implementationTaskId}/refresh-pr`, "task-refresh-pr", { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "PRの状態を更新できませんでした。");
      setNotice("PRの状態を更新しました。"); onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "PRの状態を更新できませんでした。"); }
    finally { setProcessing(false); }
  }

  async function resolve() {
    if (!window.confirm("マージ済みの指摘を解決済みにしますか？担当者による確認操作です。")) return;
    setProcessing(true); onError("");
    try {
      const response = await humanMutationFetch(`/api/findings/${finding.findingId}/resolve`, "finding-resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "指摘を解決済みにできませんでした。");
      setNotice("解決済みにしました。"); onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "解決済みにできませんでした。"); }
    finally { setProcessing(false); }
  }

  const actionTaskId = finding.implementationTaskId ?? finding.sourceTaskId;
  return <>
    <tr className={`queueRow stage-${finding.remediationStage}`}>
      <td><span className={`severityBadge ${finding.severity}`}>{severityLabels[finding.severity] ?? finding.severity}</span></td>
      <td><button type="button" className="findingTitleButton" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{finding.title}</button><small>{finding.category || "分類なし"}</small></td>
      <td>{finding.repoName}</td><td><span className={`stageBadge ${finding.remediationStage}`}>{stageLabels[finding.remediationStage]}</span></td>
      <td><strong>{nextLabels[finding.nextAction]}</strong>{notice ? <p className="actionResult actionResult-success" role="status">{notice}</p> : null}<div className="queueActions">{finding.nextAction === "mark_resolved" ? <button type="button" disabled={busy || processing} onClick={() => void resolve()}>解決済みにする</button> : finding.nextAction === "human_merge" && finding.prUrl ? <a className="buttonLink" href={finding.prUrl} target="_blank" rel="noreferrer">PRを開く</a> : <button type="button" disabled={busy || processing || !actionTaskId} onClick={() => onOpenTask(actionTaskId)}>{nextLabels[finding.nextAction]}</button>}{finding.prNumber && finding.implementationTaskId ? <button type="button" className="secondary compactButton" disabled={busy || processing} onClick={() => void refreshPr()}>PRの状態を更新</button> : null}</div></td>
    </tr>
    {expanded ? <tr className="queueDetail"><td colSpan={5}><dl><div><dt>指摘ID</dt><dd><code>{finding.findingId}</code></dd></div><div><dt>優先度</dt><dd><div className="priorityEditor"><select aria-label={`人が設定する優先度: ${finding.title}`} value={selectedPriority} disabled={busy || processing || Boolean(finding.resolvedAt)} onChange={(event) => setSelectedPriority(event.target.value as HumanPriority)}>{humanPriorities.map((value) => <option key={value} value={value}>{priorityLabels[value] ?? value}</option>)}</select><button type="button" className="compactButton" disabled={busy || processing || selectedPriority === finding.humanPriority || Boolean(finding.resolvedAt)} onClick={() => void savePriority()}>保存</button></div></dd></div><div><dt>実装</dt><dd>{finding.implementationTaskId ? <><code>{finding.implementationTaskId.slice(0, 8)}</code> · {finding.implementationTaskStatus}</> : "未作成"}</dd></div><div><dt>プルリクエスト</dt><dd>{finding.prNumber ? finding.prUrl ? <a href={finding.prUrl} target="_blank" rel="noreferrer">#{finding.prNumber}</a> : `#${finding.prNumber}` : "なし"}</dd></div><div><dt>経過</dt><dd>{age(finding.ageMs)}</dd></div><div><dt>出典</dt><dd><button type="button" className="textButton" onClick={() => onHistory(finding.sourceTaskId, `${finding.repoName} — ${finding.title}`)}>タスク履歴</button> · {finding.sourceTemplateName || "不明な種類"} v{finding.sourceTemplateVersion ?? "?"}</dd></div><div><dt>指摘の状態</dt><dd>{findingStatusLabels[finding.findingStatus] ?? finding.findingStatus}</dd></div><div><dt>更新日時</dt><dd>{new Date(finding.updatedAt).toLocaleString("ja-JP")}</dd></div></dl>{finding.attentionReason ? <p><strong>詳細:</strong> {finding.attentionReason}</p> : null}{finding.affectedPaths?.length ? <p><strong>影響するパス:</strong> {finding.affectedPaths.join(", ")}</p> : null}</td></tr> : null}
  </>;
}

function age(ageMs: number) {
  if (ageMs < 3_600_000) return `${Math.max(0, Math.floor(ageMs / 60_000))}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}
