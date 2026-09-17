import {
  OutboundInputError,
  retryOutboundNotification,
} from "../server/outbound-notifications";

type NotificationSlackRetryMutationDependencies = {
  retry: typeof retryOutboundNotification;
};

export function createNotificationSlackRetryMutationService(
  dependencies: NotificationSlackRetryMutationDependencies = {
    retry: retryOutboundNotification,
  },
) {
  return {
    async apply(notificationId: string) {
      const delivery = await dependencies.retry(notificationId);
      return { delivery };
    },
  };
}

/** Framework-independent Slack delivery retry mutation used by transport adapters. */
export const notificationSlackRetryMutationService =
  createNotificationSlackRetryMutationService();

export { OutboundInputError };
