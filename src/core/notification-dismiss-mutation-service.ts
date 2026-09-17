import type { AppNotification } from "../notifications/types";
import { getStateStore } from "../server/state-store";

type NotificationDismissMutationDependencies = {
  dismiss: ReturnType<typeof getStateStore>["dismissNotification"];
};

export function createNotificationDismissMutationService(
  dependencies: NotificationDismissMutationDependencies = {
    dismiss: (notificationId) =>
      getStateStore().dismissNotification(notificationId),
  },
) {
  return {
    apply(notificationId: string): AppNotification | undefined {
      return dependencies.dismiss(notificationId);
    },
  };
}

/** Framework-independent notification dismiss mutation used by transport adapters. */
export const notificationDismissMutationService =
  createNotificationDismissMutationService();
