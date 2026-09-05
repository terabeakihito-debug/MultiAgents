import { randomUUID } from "node:crypto";
import type { AppNotification, NotificationType } from "../notifications/types";
import {
  defaultOutboundChannelConfig,
  type NotificationDelivery,
  type OutboundChannelConfig,
  type OutboundNotification,
  type SanitizedOutboundNotification,
} from "../outbound/types";
import { getStateStore } from "./state-store";
import { sendSlackNotification, sendSlackTestNotification, slackWebhookConfigured, type SlackDeliveryResult } from "./slack-adapter";

const policyField: Record<NotificationType, keyof OutboundChannelConfig> = {
  finding_critical_created: "sendCriticalFindings",
  finding_high_created: "sendHighFindings",
  task_needs_attention: "sendNeedsAttention",
  task_ready_for_approval: "sendReadyForApproval",
  pr_changes_requested: "sendChangesRequested",
  ci_failed: "sendCiFailed",
  pr_ready_for_human_merge: "sendReadyForHumanMerge",
  task_inactive: "sendInactiveTask",
  worktree_orphaned: "sendWorktreeOrphaned",
  approval_invalidated: "sendApprovalInvalidated",
};

const safeContent: Record<NotificationType, Pick<OutboundNotification, "title" | "message">> = {
  finding_critical_created: { title: "Critical finding created", message: "A critical finding requires review." },
  finding_high_created: { title: "High finding created", message: "A high finding requires review." },
  task_needs_attention: { title: "Task needs attention", message: "A task moved to Needs Attention." },
  task_ready_for_approval: { title: "Task ready for approval", message: "A task is ready for human approval." },
  pr_changes_requested: { title: "PR changes requested", message: "A pull request requires reviewed changes." },
  ci_failed: { title: "Required CI checks failed", message: "Required checks failed for a pull request." },
  pr_ready_for_human_merge: { title: "PR ready for human merge", message: "A pull request is ready for human review and merge." },
  task_inactive: { title: "Task inactive", message: "A task has not been updated recently." },
  worktree_orphaned: { title: "Worktree needs attention", message: "A managed worktree requires manual recovery." },
  approval_invalidated: { title: "Approval invalidated", message: "A changed diff requires a new human approval." },
};

type DeliveryDependencies = { send?: (payload: SanitizedOutboundNotification) => Promise<SlackDeliveryResult>; configured?: boolean };

export function sanitizeOutboundNotification(notification: AppNotification): SanitizedOutboundNotification {
  const fixed = safeContent[notification.type];
  return {
    notificationId: notification.notificationId,
    type: notification.type,
    severity: notification.severity,
    repositoryName: sanitizeRepositoryName(notification.repoName),
    prNumber: Number.isSafeInteger(notification.prNumber) && (notification.prNumber ?? 0) > 0 ? notification.prNumber : undefined,
    title: fixed.title,
    message: fixed.message,
    actionHint: "Open MultiAgents locally for details.",
  } as SanitizedOutboundNotification;
}

export function parseOutboundChannelConfig(value: unknown): OutboundChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutboundInputError("Outbound preferences must be an object");
  const keys = Object.keys(defaultOutboundChannelConfig) as Array<keyof OutboundChannelConfig>;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key as keyof OutboundChannelConfig))) throw new OutboundInputError("Outbound preferences must contain exactly the supported fields");
  if (record.channel !== "slack") throw new OutboundInputError("Outbound channel must be Slack");
  if (typeof record.channelLabel !== "string" || !record.channelLabel.trim() || record.channelLabel.length > 80 || /[\u0000-\u001f\u007f]/.test(record.channelLabel)) throw new OutboundInputError("Slack channel label must be 1 to 80 printable characters");
  for (const key of keys.filter((key) => key !== "channel" && key !== "channelLabel")) if (typeof record[key] !== "boolean") throw new OutboundInputError("Outbound preference values must be boolean");
  return { ...(record as OutboundChannelConfig), channelLabel: record.channelLabel.trim() as string };
}

export function outboundSettingsView() {
  return { configured: slackWebhookConfigured(), config: getStateStore().loadOutboundChannelConfig() };
}

export async function dispatchOutboundNotification(notificationId: string, dependencies: DeliveryDependencies = {}): Promise<NotificationDelivery> {
  const store = getStateStore();
  const notification = store.loadNotification(notificationId);
  if (!notification) throw new OutboundInputError("Notification not found");
  const config = store.loadOutboundChannelConfig();
  const allowed = config.enabled && config[policyField[notification.type]] === true;
  const configured = dependencies.configured ?? (process.env.NODE_ENV === "test" ? false : slackWebhookConfigured());
  if (!allowed || !configured) {
    store.reserveNotificationDelivery(notificationId, "suppressed", allowed ? "not_configured" : "policy_suppressed");
    return store.loadNotificationDelivery(notificationId)!;
  }
  if (!store.reserveNotificationDelivery(notificationId, "pending")) return store.loadNotificationDelivery(notificationId)!;
  return attemptDelivery(notification, dependencies.send ?? sendSlackNotification, false);
}

export async function retryOutboundNotification(notificationId: string, dependencies: DeliveryDependencies = {}): Promise<NotificationDelivery> {
  const store = getStateStore();
  const notification = store.loadNotification(notificationId);
  if (!notification) throw new OutboundInputError("Notification not found");
  const config = store.loadOutboundChannelConfig();
  if (!config.enabled || config[policyField[notification.type]] !== true) throw new OutboundInputError("Slack delivery is disabled by outbound policy");
  if (!(dependencies.configured ?? slackWebhookConfigured())) throw new OutboundInputError("Slack is not configured");
  if (!store.beginNotificationDeliveryRetry(notificationId)) throw new OutboundInputError("Only a failed Slack delivery can be retried");
  return attemptDelivery(notification, dependencies.send ?? sendSlackNotification, true);
}

export async function sendFixedSlackTest(dependencies: { send?: () => Promise<SlackDeliveryResult>; configured?: boolean } = {}) {
  if (!(dependencies.configured ?? slackWebhookConfigured())) throw new OutboundInputError("Slack is not configured");
  const auditId = randomUUID();
  const store = getStateStore();
  store.appendOutboundAudit("outbound_delivery_attempted", auditId, "pending");
  const result = await (dependencies.send ?? sendSlackTestNotification)();
  store.appendOutboundAudit(result.delivered ? "outbound_delivery_succeeded" : "outbound_delivery_failed", auditId, result.delivered ? "delivered" : "failed");
  return result;
}

async function attemptDelivery(notification: AppNotification, send: (payload: SanitizedOutboundNotification) => Promise<SlackDeliveryResult>, retry: boolean) {
  const store = getStateStore();
  if (retry) store.appendOutboundAudit("outbound_delivery_retried", notification.notificationId, "pending");
  store.markNotificationDeliveryAttempted(notification.notificationId);
  store.appendOutboundAudit("outbound_delivery_attempted", notification.notificationId, "pending");
  let result: SlackDeliveryResult;
  try { result = await send(sanitizeOutboundNotification(notification)); }
  catch { result = { delivered: false, errorCode: "adapter_error" }; }
  const status = result.delivered ? "delivered" : "failed";
  store.completeNotificationDelivery(notification.notificationId, status, result.delivered ? undefined : result.errorCode);
  store.appendOutboundAudit(result.delivered ? "outbound_delivery_succeeded" : "outbound_delivery_failed", notification.notificationId, status);
  return store.loadNotificationDelivery(notification.notificationId)!;
}

function sanitizeRepositoryName(value: string | undefined) {
  if (!value || value.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(value)) return undefined;
  if (/(?:authorization|cookie|credential|password|secret|token|bearer|gh[pousr]_|github_pat_|sk-)/i.test(value)) return undefined;
  return value;
}

export class OutboundInputError extends Error {}
