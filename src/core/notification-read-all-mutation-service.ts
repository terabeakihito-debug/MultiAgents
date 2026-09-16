import { getStateStore } from "../server/state-store";

type NotificationReadAllMutationDependencies = {
  markAllRead: ReturnType<typeof getStateStore>["markAllNotificationsRead"];
};

export function createNotificationReadAllMutationService(
  dependencies: NotificationReadAllMutationDependencies = {
    markAllRead: () => getStateStore().markAllNotificationsRead(),
  },
) {
  return {
    apply() {
      return { updated: dependencies.markAllRead() };
    },
  };
}

/** Framework-independent notification read-all mutation used by transport adapters. */
export const notificationReadAllMutationService =
  createNotificationReadAllMutationService();
