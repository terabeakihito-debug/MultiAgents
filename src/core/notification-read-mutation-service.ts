import { getStateStore } from "../server/state-store";
import type { AppNotification } from "../notifications/types";

type NotificationReadMutationDependencies = {
  markRead: ReturnType<typeof getStateStore>["markNotificationRead"];
};

export function createNotificationReadMutationService(
  dependencies: NotificationReadMutationDependencies = {
    markRead: (notificationId) =>
      getStateStore().markNotificationRead(notificationId),
  },
) {
  return {
    apply(notificationId: string): AppNotification | undefined {
      return dependencies.markRead(notificationId);
    },
  };
}

/** Framework-independent notification read mutation used by transport adapters. */
export const notificationReadMutationService =
  createNotificationReadMutationService();
