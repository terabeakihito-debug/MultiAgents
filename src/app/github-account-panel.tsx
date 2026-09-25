"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { GitHubAccountView, GitHubRemoteRepositoryView } from "@/github/types";
import { humanMutationFetch } from "./human-mutation";

export function GitHubAccountPanel({ onCloneUrl }: { onCloneUrl?: (url: string) => void }) {
  const [account, setAccount] = useState<GitHubAccountView | null>(null);
  const [repositories, setRepositories] = useState<GitHubRemoteRepositoryView[]>([]);
  const [token, setToken] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setFailed(false);
    try {
      const accountResponse = await fetch("/api/github/account", { cache: "no-store" });
      const accountData = await accountResponse.json() as GitHubAccountView & { error?: string };
      if (!accountResponse.ok) throw new Error(accountData.error || "GitHub account status is unavailable");
      setAccount(accountData);
      if (!accountData.connected) {
        setRepositories([]);
        return;
      }
      const repositoriesResponse = await fetch("/api/github/repositories", { cache: "no-store" });
      const repositoriesData = await repositoriesResponse.json() as {
        repositories?: GitHubRemoteRepositoryView[];
        error?: string;
      };
      if (!repositoriesResponse.ok) throw new Error(repositoriesData.error || "GitHub repositories are unavailable");
      setRepositories(repositoriesData.repositories ?? []);
    } catch {
      setFailed(true);
      setAccount(null);
      setRepositories([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await humanMutationFetch("/api/github/connect", "github-connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await response.json() as { account?: GitHubAccountView; error?: string };
      if (!response.ok || !data.account) throw new Error(data.error || "GitHub connection failed");
      setAccount(data.account);
      setToken("");
      setNotice("GitHubアカウントを接続しました。");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "GitHub connection failed");
    } finally {
      setBusy(false);
    }
  }

  return <section className="githubAccountPanel" aria-labelledby="github-account-heading">
    <div className="profileHeading">
      <div>
        <span className="eyebrow">GitHub</span>
        <h2 id="github-account-heading">アカウントとリポジトリ</h2>
      </div>
      <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>再確認</button>
    </div>
    {failed ? <p className="muted">GitHubの接続状態を取得できませんでした。</p> : null}
    {account ? <p className="githubAccountStatus">
      <span className={`credentialState ${account.connected ? "configured" : "not_configured"}`}>
        {account.connected ? "接続済み" : "未接続"}
      </span>
      {account.connected && account.login ? <> · <strong>{account.login}</strong> @ {account.hostname}</> : null}
      {!account.connected ? <> · {account.detail}</> : null}
    </p> : null}
    {!account?.connected ? <form className="githubConnectForm" onSubmit={(event) => void connect(event)}>
      <p className="muted">GitHub CLI (<code>gh auth login</code>) でも接続できます。ブラウザから接続する場合は、classic または fine-grained の personal access token を入力してください。トークンは保存しません。</p>
      <label>Personal access token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} placeholder="github_pat_… または ghp_…" /></label>
      <button type="submit" disabled={busy || !token.trim()}>{busy ? "接続中…" : "GitHubアカウントを接続"}</button>
    </form> : null}
    {notice ? <p className={notice.includes("失敗") || notice.includes("failed") ? "taskStartNotice error" : "muted"} role="status">{notice}</p> : null}
    {account?.connected ? <>
      <p className="muted">GitHub CLI 経由で取得したリポジトリ一覧です（最大100件）。ローカル管理済みの項目には印を付けます。</p>
      {repositories.length ? <ul className="githubRepoList">
        {repositories.map((repository) => <li key={repository.nameWithOwner}>
          <div>
            <strong>{repository.nameWithOwner}</strong>
            {repository.isPrivate ? <span className="githubRepoBadge">非公開</span> : null}
            {repository.isFork ? <span className="githubRepoBadge">フォーク</span> : null}
            {repository.managedLocally ? <span className="githubRepoBadge managed">管理済み</span> : null}
            {repository.description ? <p className="muted">{repository.description}</p> : null}
          </div>
          <div className="githubRepoActions">
            <a href={repository.url} target="_blank" rel="noreferrer">GitHubで開く</a>
            {onCloneUrl && !repository.managedLocally ? <button type="button" className="secondary compactButton" onClick={() => onCloneUrl(repository.url)}>追加URLに使う</button> : null}
          </div>
        </li>)}
      </ul> : <p className="muted">表示できるリポジトリがありません。</p>}
    </> : null}
  </section>;
}
