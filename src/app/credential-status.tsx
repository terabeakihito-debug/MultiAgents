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
        if (!response.ok || !Array.isArray(data.credentials)) throw new Error("Credential status unavailable");
        setCredentials(data.credentials);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  return <section className="credentialPanel" aria-labelledby="credentials-heading">
    <div><span className="eyebrow">Security</span><h2 id="credentials-heading">Credentials</h2></div>
    {failed ? <p className="muted">Credential status is unavailable.</p> : credentials.length ? <div className="credentialGrid">
      {credentials.map((credential) => <article key={credential.capability}>
        <strong>{labels[credential.capability]}</strong>
        <span className={`credentialState ${credential.status}`}>{statusLabel(credential.status)}</span>
        <small>{credential.source === "environment" ? "Source: Environment" : "Managed by the CLI credential store"}</small>
        {credential.capability === "slack_outbound" ? <small>Secret value: Never displayed</small> : null}
      </article>)}
    </div> : <p className="muted">Checking credential status…</p>}
    <p className="muted">Values cannot be viewed, copied, edited, or downloaded. Environment changes take effect after a server restart.</p>
  </section>;
}

function statusLabel(status: CredentialStatusView["status"]) {
  if (status === "externally_managed") return "Externally managed";
  if (status === "not_configured") return "Not configured";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
