"use client";

import { useEffect, useState } from "react";
import type { CredentialCapability, CredentialStatusView } from "@/credentials/types";

const labels: Record<CredentialCapability, string> = {
  slack_outbound: "Slack",
  github_cli: "GitHub CLI",
  agent_codex: "Codex",
  agent_cursor: "Cursor",
  agent_claude: "Claude",
};

export function CredentialStatusPanel() {
  const [credentials, setCredentials] = useState<CredentialStatusView[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/credentials/status", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { credentials?: CredentialStatusView[] };
        if (!response.ok || !Array.isArray(data.credentials)) throw new Error("認証状態を取得できませんでした。");
        setCredentials(data.credentials);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  return <section className="credentialPanel" aria-labelledby="credentials-heading">
    <div><span className="eyebrow">安全</span><h2 id="credentials-heading">認証情報</h2></div>
    {failed ? <p className="muted">認証状態を取得できませんでした。</p> : credentials.length ? <div className="credentialGrid">
      {credentials.map((credential) => <article key={credential.capability}>
        <strong>{labels[credential.capability]}</strong>
        <span className={`credentialState ${credential.status}`}>{statusLabel(credential.status)}</span>
        <small>{credential.source === "environment" ? "取得元: 環境変数" : "CLIの認証情報ストアで管理"}</small>
        {credential.capability === "slack_outbound" ? <small>秘密値: 表示しません</small> : null}
      </article>)}
    </div> : <p className="muted">認証状態を確認しています…</p>}
    <p className="muted">値の表示・コピー・編集・ダウンロードはできません。環境変数の変更はサーバー再起動後に反映されます。</p>
  </section>;
}

function statusLabel(status: CredentialStatusView["status"]) {
  if (status === "externally_managed") return "外部で管理";
  if (status === "not_configured") return "未設定";
  if (status === "configured") return "設定済み";
  if (status === "unavailable") return "利用不可";
  return status;
}
