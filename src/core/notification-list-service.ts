import {
  NotificationInputError,
  parseNotificationQuery,
} from "../server/notifications";
import { getStateStore } from "../server/state-store";

type NotificationListDependencies = {
  parseQuery: typeof parseNotificationQuery;
  queryNotifications: ReturnType<typeof getStateStore>["queryNotifications"];
};

export function createNotificationListService(dependencies: NotificationListDependencies = {
  parseQuery: parseNotificationQuery,
  queryNotifications: (input) => getStateStore().queryNotifications(input),
}) {
  return {
    load(url: URL) {
      const query = dependencies.parseQuery(url);
      return dependencies.queryNotifications(query);
    },
  };
}

/** Framework-independent notification list read boundary used by transport adapters. */
export const notificationListService = createNotificationListService();

export { NotificationInputError };
