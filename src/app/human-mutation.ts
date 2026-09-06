import type { HumanMutationAction } from "@/security/human-actions";

type NonceResponse = { nonce?: string; error?: string };

export async function humanMutationFetch(input: RequestInfo | URL, action: HumanMutationAction, init: RequestInit = {}) {
  const bootstrap = await fetch("/api/human-session", { cache: "no-store", credentials: "same-origin" });
  const data = await bootstrap.json() as NonceResponse;
  if (!bootstrap.ok || !data.nonce) throw new Error(data.error || "Could not authorize the human action");
  const headers = new Headers(init.headers);
  headers.set("X-MultiAgents-Human-Action", action);
  headers.set("X-MultiAgents-Human-Nonce", data.nonce);
  return fetch(input, { ...init, headers, credentials: "same-origin" });
}
