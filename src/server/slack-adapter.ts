import type { SanitizedOutboundNotification } from "../outbound/types";
import { CredentialAccessError, credentialResolver, type CredentialResolver } from "./credential-resolver";

export const SLACK_TIMEOUT_MS = 10_000;
export const SLACK_TEST_TEXT = "MultiAgents test notification.\nExternal Slack notifications are configured.";

export type SlackDeliveryResult = { delivered: true } | { delivered: false; errorCode: string };
type SlackDependencies = { fetchImpl?: typeof fetch; timeoutMs?: number; resolver?: CredentialResolver };

export function slackWebhookConfigured(resolver: CredentialResolver = credentialResolver) {
  return resolver.status("slack_outbound").status === "configured";
}

export async function sendSlackNotification(payload: SanitizedOutboundNotification, dependencies: SlackDependencies = {}): Promise<SlackDeliveryResult> {
  return postSlackText(formatSlackNotification(payload), dependencies);
}

export async function sendSlackTestNotification(dependencies: SlackDependencies = {}): Promise<SlackDeliveryResult> {
  return postSlackText(SLACK_TEST_TEXT, dependencies);
}

function formatSlackNotification(payload: SanitizedOutboundNotification) {
  const lines = ["MultiAgents", "", payload.severity.toUpperCase(), payload.title];
  if (payload.repositoryName) lines.push("", "Repository:", payload.repositoryName);
  if (payload.prNumber) lines.push("", "PR:", `#${payload.prNumber}`);
  lines.push("", payload.actionHint || "Open MultiAgents locally for details.");
  return lines.join("\n");
}

async function postSlackText(text: string, dependencies: SlackDependencies): Promise<SlackDeliveryResult> {
  try {
    return await (dependencies.resolver ?? credentialResolver).withCredential("slack_outbound", async (credential) => {
      const webhookUrl = validSlackWebhookUrl(credential.revealForCapability("slack_outbound"));
      if (!webhookUrl) return { delivered: false, errorCode: "invalid_credential" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? SLACK_TIMEOUT_MS);
      try {
        const response = await (dependencies.fetchImpl ?? fetch)(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        return response.ok ? { delivered: true } : { delivered: false, errorCode: `http_${response.status}` };
      } catch (error) {
        return { delivered: false, errorCode: isAbortError(error, controller.signal) ? "timeout" : "network_error" };
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (error) {
    if (error instanceof CredentialAccessError) return { delivered: false, errorCode: "not_configured" };
    return { delivered: false, errorCode: "credential_unavailable" };
  }
}

function validSlackWebhookUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || url.port || url.username || url.password) return undefined;
    if (!/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
