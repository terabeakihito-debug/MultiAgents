"use client";

import { useState, type FormEvent } from "react";
import { GitHubAccountPanel } from "./github-account-panel";
import { humanMutationFetch } from "./human-mutation";

export type AddedProject = { id: string; name: string };
type Choice = "menu" | "github" | "local" | "create" | "ready";

export function ProjectOnboarding({ disabled, onAdded, onError, initializationRequiredProject, initializationRepairRequired = false }: { disabled: boolean; onAdded: (project: AddedProject, needsInitialCommit: boolean) => void; onError: (error: string) => void; initializationRequiredProject?: AddedProject; initializationRepairRequired?: boolean }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>("menu");
  const [githubUrl, setGithubUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [createReadme, setCreateReadme] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdProject, setCreatedProject] = useState<AddedProject | null>(null);

  function close() { if (!busy) { setOpen(false); setChoice("menu"); setStatus(""); setError(""); } }
  function reopenInitialization() { if (initializationRequiredProject) { setCreatedProject(initializationRequiredProject); setChoice("ready"); setError(""); setOpen(true); } }
  async function submit(event: FormEvent, endpoint: "/api/repos/clone" | "/api/repos/create", action: "repository-clone" | "repository-create") {
    event.preventDefault(); setError(""); setBusy(true); setStatus(endpoint.endsWith("clone") ? "GitHubプロジェクトを確認しています…" : "プロジェクトを作成しています…");
    try {
      setStatus(endpoint.endsWith("clone") ? "取得しています…" : "準備しています…");
      const response = await humanMutationFetch(endpoint, action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(endpoint.endsWith("clone") ? { githubUrl } : { projectName, createReadme }) });
      const data = await response.json() as { repo?: AddedProject; needsInitialCommit?: boolean; error?: string };
      if (!response.ok || !data.repo) throw new Error(data.error || "プロジェクトの設定に失敗しました。");
      setStatus("準備完了"); onAdded(data.repo, data.needsInitialCommit === true);
      if (data.needsInitialCommit === true) { setCreatedProject(data.repo); setChoice("ready"); } else { setOpen(false); setChoice("menu"); }
    } catch (error) { const message = error instanceof Error ? error.message : "プロジェクトの設定に失敗しました。"; setStatus(""); setError(message); onError(message); }
    finally { setBusy(false); }
  }
  async function initialize() {
    if (!createdProject) return; setError(""); setBusy(true); setStatus("プロジェクトを初期化しています…");
    try { const response = await humanMutationFetch(`/api/repos/${encodeURIComponent(createdProject.id)}/initialize`, "repository-initialize", { method: "POST" }); const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "プロジェクトの初期化に失敗しました。"); onAdded(createdProject, false); setOpen(false); setChoice("menu"); setCreatedProject(null); }
    catch (error) { const message = error instanceof Error ? error.message : "プロジェクトの初期化に失敗しました。"; if (message.startsWith("Initial commit was created")) onAdded(createdProject, false); setError(message); onError(message); }
    finally { setBusy(false); setStatus(""); }
  }
  return <>{initializationRequiredProject ? <div className="initializationNotice" role="status"><strong>{initializationRepairRequired ? "タスク開始前にプロジェクト設定を完了してください" : "タスク開始前にプロジェクトを初期化してください"}</strong><span>{initializationRepairRequired ? "初回commitはありますが、プロジェクト設定が未完了です。" : "このローカルプロジェクトには初回commitがありません。"}</span><button type="button" className="secondary" disabled={disabled} onClick={reopenInitialization}>{initializationRepairRequired ? "設定を完了" : "プロジェクトを初期化"}</button></div> : null}<button type="button" className="secondary addProjectButton" disabled={disabled} onClick={() => { setError(""); setOpen(true); }}>＋ プロジェクトを追加</button>
    {open ? <div className="dialogBackdrop" role="presentation"><section className="projectOnboarding" role="dialog" aria-modal="true" aria-labelledby="add-project-title"><div className="projectDialogHeader"><div><span className="eyebrow">プロジェクト</span><h2 id="add-project-title">プロジェクトを追加</h2></div><button type="button" className="secondary" disabled={busy} onClick={close}>閉じる</button></div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {choice === "menu" ? <div className="projectChoices"><button type="button" onClick={() => setChoice("github")}><strong>GitHubから追加</strong><small>GitHubリポジトリのURLを入力し、ローカルに準備します。</small></button><button type="button" onClick={() => setChoice("local")}><strong>既存のローカルプロジェクトを使う</strong><small>管理対象フォルダーにあるプロジェクトは自動検出されます。</small></button><button type="button" onClick={() => setChoice("create")}><strong>新しいプロジェクトを作成</strong><small>ローカルで新規作成します。GitHubは後から接続できます。</small></button></div> : null}
      {choice === "github" ? <div><GitHubAccountPanel onCloneUrl={(url) => setGithubUrl(url)} /><form onSubmit={(event) => void submit(event, "/api/repos/clone", "repository-clone")}><p className="muted">GitHubのHTTPSまたはSSH形式のURLだけ利用できます。上の一覧から選ぶか、URLを直接入力してください。</p><label>GitHubリポジトリURL<input autoFocus value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repository" required disabled={busy} /></label><div className="dialogActions"><button type="button" className="secondary" disabled={busy} onClick={() => setChoice("menu")}>戻る</button><button type="submit" disabled={busy || !githubUrl.trim()}>{busy ? status || "実行中…" : "GitHubから追加"}</button></div></form></div> : null}
      {choice === "local" ? <div><p>管理対象フォルダー内のプロジェクトは自動検出されます。既存のGitプロジェクトを <code>~/code</code> に直接置き、この画面に戻るかタスク画面を更新してください。</p><p className="muted">このアプリではローカルパスを直接入力する操作は安全のため対応していません。</p><div className="dialogActions"><button type="button" onClick={() => setChoice("menu")}>戻る</button></div></div> : null}
      {choice === "create" ? <form onSubmit={(event) => void submit(event, "/api/repos/create", "repository-create")}><p>MultiAgentsがGitを安全に管理するため、手動でGitを操作する必要はありません。</p><label>プロジェクト名<input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="MyApp" required disabled={busy} /></label><label className="checkboxLabel"><input type="checkbox" checked={createReadme} onChange={(event) => setCreateReadme(event.target.checked)} disabled={busy} /> READMEを最初に追加する</label><p className="muted">GitHubは未接続です。後から接続できます。初回commitは自動作成されません。</p><div className="dialogActions"><button type="button" className="secondary" disabled={busy} onClick={() => setChoice("menu")}>戻る</button><button type="submit" disabled={busy || !projectName.trim()}>{busy ? status || "実行中…" : "プロジェクトを作成"}</button></div></form> : null}
      {choice === "ready" && createdProject ? <div><h3>{initializationRepairRequired ? "プロジェクト設定を完了" : "プロジェクトを作成しました"}</h3><p>{initializationRepairRequired ? "初回commitは作成済みです。承認済みREADMEを反映するため設定を完了してください。再試行してもcommitは増えません。" : "MultiAgentsがGitを安全に管理します。タスクを開始するには初回設定commitを作成してください。"}</p><p className="muted">GitHubは未接続です。後から接続できます。</p><div className="dialogActions"><button type="button" className="secondary" disabled={busy} onClick={close}>後で行う</button><button type="button" disabled={busy} onClick={() => void initialize()}>{busy ? status || "実行中…" : initializationRepairRequired ? "設定を完了" : "プロジェクトを初期化"}</button></div></div> : null}
    </section></div> : null}</>;
}
