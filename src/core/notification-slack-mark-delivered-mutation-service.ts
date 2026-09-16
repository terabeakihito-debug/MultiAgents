import {
  markAmbiguousDelivery,
  OutboundInputError,
} from "../server/outbound-notifications";

type NotificationSlackMarkDeliveredMutationDependencies = {
  markDelivered: (notificationId: string) => ReturnType<
    typeof markAmbiguousDelivery
  >;
};

export function createNotificationSlackMarkDeliveredMutationService(
  dependencies: NotificationSlackMarkDeliveredMutationDependencies = {
    markDelivered: (notificationId) =>
      markAmbiguousDelivery(notificationId, "delivered"),
  },
) {
  return {
    apply(notificationId: string) {
      return { delivery: dependencies.markDelivered(notificationId) };
    },
  };
}

/** Framework-independent Slack mark-delivered mutation used by transport adapters. */
export const notificationSlackMarkDeliveredMutationService =
  createNotificationSlackMarkDeliveredMutationService();

export { OutboundInputError };
