import {
  markAmbiguousDelivery,
  OutboundInputError,
} from "../server/outbound-notifications";

type NotificationSlackDeliveryDismissMutationDependencies = {
  dismissDelivery: (notificationId: string) => ReturnType<
    typeof markAmbiguousDelivery
  >;
};

export function createNotificationSlackDeliveryDismissMutationService(
  dependencies: NotificationSlackDeliveryDismissMutationDependencies = {
    dismissDelivery: (notificationId) =>
      markAmbiguousDelivery(notificationId, "dismissed"),
  },
) {
  return {
    apply(notificationId: string) {
      return { delivery: dependencies.dismissDelivery(notificationId) };
    },
  };
}

/** Framework-independent Slack delivery dismiss mutation used by transport adapters. */
export const notificationSlackDeliveryDismissMutationService =
  createNotificationSlackDeliveryDismissMutationService();

export { OutboundInputError };
