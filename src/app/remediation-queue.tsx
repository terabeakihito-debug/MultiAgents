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
  untriaged: "Untriaged", accepted: "Accepted", implementation_not_created: "Implementation not created",
  implementation_active: "Implementation active", awaiting_approval: "Awaiting approval", pr_open: "PR open",
  ready_for_human_merge: "Ready for human merge", resolved_candidate: "Merged · resolution pending",
  resolved: "Resolved", dismissed: "Dismissed", needs_attention: "Needs attention",
};
const nextLabels: Record<string, string> = {
  review_finding: "Review finding", accept_or_dismiss: "Accept or dismiss", create_implementation_task: "Create implementation task",
  resume_implementation: "Resume implementation", review_diff: "Review diff", open_pr: "Open PR", fetch_pr_review: "Refresh PR status",
  human_merge: "Human merge", mark_resolved: "Mark resolved", manual_recovery: "Manual recovery", none: "No action",
};

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
        if (!response.ok) throw new Error(result.error || "Could not load remediation queue");
        setData(result);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) onError(error instanceof Error ? error.message : "Could not load remediation queue");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [converted, includeDismissed, includeResolved, onError, pr, priority, refreshSequence, refreshToken, repo, search, severity, sort, stage, status]);

  function refresh() { setRefreshSequence((value) => value + 1); }

  return <section className="remediationQueue" aria-labelledby="remediation-queue-title">
    <div className="dashboardTitle"><div><span className="eyebrow">Cross-repository findings</span><h2 id="remediation-queue-title">Remediation Queue</h2></div><button type="button" className="secondary" onClick={refresh}>Refresh queue</button></div>
    <div className="remediationCounts" aria-label="Remediation queue counts">
      <span><strong>{data.counts.critical}</strong> Critical</span><span><strong>{data.counts.high}</strong> High</span>
      <span><strong>{data.counts.acceptedNotConverted}</strong> Accepted not converted</span><span><strong>{data.counts.needsAttention}</strong> Needs Attention</span>
      <span><strong>{data.counts.readyForMerge}</strong> Ready for Merge</span>
    </div>
    <div className="dashboardFilters remediationFilters">
      <label>Repository<select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">All repositories</option>{repos.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Severity<select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">All severities</option>{findingSeverities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Human priority<select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">All priorities</option>{humanPriorities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Finding status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{findingStatuses.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Stage<select value={stage} onChange={(event) => setStage(event.target.value)}><option value="">All stages</option>{remediationStages.map((value) => <option key={value} value={value}>{stageLabels[value]}</option>)}</select></label>
      <label>Pull request<select value={pr} onChange={(event) => setPr(event.target.value)}><option value="any">With or without PR</option><option value="yes">PR exists</option><option value="no">No PR</option></select></label>
      <label>Converted<select value={converted} onChange={(event) => setConverted(event.target.value)}><option value="any">Converted or not</option><option value="yes">Converted</option><option value="no">Not converted</option></select></label>
      <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="recommended">Recommended priority</option><option value="severity">Severity</option><option value="age">Age</option><option value="updated">Updated</option><option value="repo">Repository</option></select></label>
      <label className="searchFilter">Search<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Finding, category, repo, path, PR #" /></label>
      <label className="archiveToggle"><input type="checkbox" checked={includeDismissed} onChange={(event) => setIncludeDismissed(event.target.checked)} /> Include dismissed</label>
      <label className="archiveToggle"><input type="checkbox" checked={includeResolved} onChange={(event) => setIncludeResolved(event.target.checked)} /> Include resolved</label>
    </div>
    {loading ? <p className="muted">Loading findings…</p> : data.findings.length ? <div className="queueTableWrap"><table className="queueTable"><thead><tr><th>Priority</th><th>Severity</th><th>Finding</th><th>Repository</th><th>Stage</th><th>Implementation</th><th>PR</th><th>Age</th><th>Next Action</th></tr></thead><tbody>{data.findings.map((finding) => <QueueRow key={`${finding.findingId}-${finding.humanPriority}`} finding={finding} busy={busy} onOpenTask={onOpenTask} onHistory={onHistory} onError={onError} onChanged={refresh} />)}</tbody></table></div> : <p className="emptyDashboard">No findings match these filters.</p>}
  </section>;
}

function QueueRow({ finding, busy, onOpenTask, onHistory, onError, onChanged }: { finding: RemediationQueueItem; busy: boolean; onOpenTask: Props["onOpenTask"]; onHistory: Props["onHistory"]; onError: Props["onError"]; onChanged: () => void }) {
  const [selectedPriority, setSelectedPriority] = useState<HumanPriority>(finding.humanPriority);
  const [processing, setProcessing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function savePriority() {
    setProcessing(true); onError("");
    try {
      const response = await fetch(`/api/findings/${finding.findingId}/priority`, { method: "POST", headers: { "Content-Type": "application/json", "X-MultiAgents-Human-Action": "finding-priority" }, body: JSON.stringify({ confirmed: true, priority: selectedPriority }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Priority update failed");
      onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "Priority update failed"); }
    finally { setProcessing(false); }
  }

  async function refreshPr() {
    if (!finding.implementationTaskId) return;
    setProcessing(true); onError("");
    try {
      const response = await fetch(`/api/tasks/${finding.implementationTaskId}/refresh-pr`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "PR status refresh failed");
      onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "PR status refresh failed"); }
    finally { setProcessing(false); }
  }

  async function resolve() {
    if (!window.confirm("Mark this merged finding resolved? This is a human audit action.")) return;
    setProcessing(true); onError("");
    try {
      const response = await fetch(`/api/findings/${finding.findingId}/resolve`, { method: "POST", headers: { "Content-Type": "application/json", "X-MultiAgents-Human-Action": "finding-resolve" }, body: JSON.stringify({ confirmed: true }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Finding resolution failed");
      onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "Finding resolution failed"); }
    finally { setProcessing(false); }
  }

  const actionTaskId = finding.implementationTaskId ?? finding.sourceTaskId;
  return <>
    <tr className={`queueRow stage-${finding.remediationStage}`}>
      <td><div className="priorityEditor"><select aria-label={`Human priority for ${finding.title}`} value={selectedPriority} disabled={busy || processing || Boolean(finding.resolvedAt)} onChange={(event) => setSelectedPriority(event.target.value as HumanPriority)}>{humanPriorities.map((value) => <option key={value} value={value}>{value}</option>)}</select><button type="button" className="compactButton" disabled={busy || processing || selectedPriority === finding.humanPriority || Boolean(finding.resolvedAt)} onClick={() => void savePriority()}>Save</button></div></td>
      <td><span className={`severityBadge ${finding.severity}`}>{finding.severity.toUpperCase()}</span></td>
      <td><button type="button" className="findingTitleButton" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{finding.title}</button><small>{finding.category || "Uncategorized"}</small></td>
      <td>{finding.repoName}</td><td><span className={`stageBadge ${finding.remediationStage}`}>{stageLabels[finding.remediationStage]}</span>{finding.attentionReason ? <small>{finding.attentionReason}</small> : null}</td>
      <td>{finding.implementationTaskId ? <><code>{finding.implementationTaskId.slice(0, 8)}</code><small>{finding.implementationTaskStatus}</small></> : "Not created"}</td>
      <td>{finding.prNumber ? <>{finding.prUrl ? <a href={finding.prUrl} target="_blank" rel="noreferrer">#{finding.prNumber}</a> : `#${finding.prNumber}`}<small>{finding.prState || "Stored state"}</small></> : "None"}</td>
      <td>{age(finding.ageMs)}</td>
      <td><strong>{nextLabels[finding.nextAction]}</strong><div className="queueActions">{finding.nextAction === "mark_resolved" ? <button type="button" disabled={busy || processing} onClick={() => void resolve()}>Mark resolved</button> : finding.nextAction === "human_merge" && finding.prUrl ? <a className="buttonLink" href={finding.prUrl} target="_blank" rel="noreferrer">Open PR</a> : <button type="button" disabled={busy || processing || !actionTaskId} onClick={() => onOpenTask(actionTaskId)}>Open</button>}{finding.prNumber && finding.implementationTaskId ? <button type="button" className="secondary compactButton" disabled={busy || processing} onClick={() => void refreshPr()}>Refresh PR</button> : null}</div></td>
    </tr>
    {expanded ? <tr className="queueDetail"><td colSpan={9}><dl><div><dt>Finding ID</dt><dd><code>{finding.findingId}</code></dd></div><div><dt>Source</dt><dd><button type="button" className="textButton" onClick={() => onHistory(finding.sourceTaskId, `${finding.repoName} — ${finding.title}`)}>Task history</button> · {finding.sourceTemplateName || "Unknown template"} v{finding.sourceTemplateVersion ?? "?"}</dd></div><div><dt>Finding status</dt><dd>{finding.findingStatus}</dd></div><div><dt>Next action</dt><dd>{nextLabels[finding.nextAction]}</dd></div><div><dt>Updated</dt><dd>{new Date(finding.updatedAt).toLocaleString()}</dd></div></dl>{finding.affectedPaths?.length ? <p><strong>Affected paths:</strong> {finding.affectedPaths.join(", ")}</p> : null}</td></tr> : null}
  </>;
}

function age(ageMs: number) {
  if (ageMs < 3_600_000) return `${Math.max(0, Math.floor(ageMs / 60_000))}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}
