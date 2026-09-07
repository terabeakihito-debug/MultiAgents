import type { NotificationSeverity, NotificationType } from "../notifications/types";

export type OutboundChannel = "slack";
export type DeliveryStatus = "pending" | "delivered" | "failed" | "suppressed" | "ambiguous";

export type OutboundNotification = {
  notificationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  repositoryName?: string;
  taskSummary?: string;
  prNumber?: number;
  title: string;
  message: string;
  actionHint?: string;
};

declare const outboundSanitized: unique symbol;
export type SanitizedOutboundNotification = OutboundNotification & { readonly [outboundSanitized]: true };

export type NotificationDelivery = {
  notificationId: string;
  channel: OutboundChannel;
  status: DeliveryStatus;
  attemptedAt?: string;
  deliveredAt?: string;
  errorCode?: string;
  attemptId?: string;
  startedAt?: string;
  leaseExpiresAt?: string;
};

export type OutboundChannelConfig = {
  channel: "slack";
  enabled: boolean;
  channelLabel: string;
  sendCriticalFindings: boolean;
  sendHighFindings: boolean;
  sendNeedsAttention: boolean;
  sendReadyForApproval: boolean;
  sendChangesRequested: boolean;
  sendCiFailed: boolean;
  sendReadyForHumanMerge: boolean;
  sendInactiveTask: boolean;
  sendWorktreeOrphaned: boolean;
  sendApprovalInvalidated: boolean;
};

export const defaultOutboundChannelConfig: OutboundChannelConfig = {
  channel: "slack",
  enabled: true,
  channelLabel: "Slack",
  sendCriticalFindings: true,
  sendHighFindings: true,
  sendNeedsAttention: true,
  sendReadyForApproval: false,
  sendChangesRequested: true,
  sendCiFailed: true,
  sendReadyForHumanMerge: true,
  sendInactiveTask: false,
  sendWorktreeOrphaned: false,
  sendApprovalInvalidated: false,
};
