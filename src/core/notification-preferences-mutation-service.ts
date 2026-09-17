import {
  NotificationInputError,
  parseNotificationPreferences,
} from "../server/notifications";
import { getStateStore } from "../server/state-store";

type NotificationPreferencesMutationDependencies = {
  parse: typeof parseNotificationPreferences;
  save: ReturnType<typeof getStateStore>["saveNotificationPreferences"];
};

export function createNotificationPreferencesMutationService(
  dependencies: NotificationPreferencesMutationDependencies = {
    parse: parseNotificationPreferences,
    save: (preferences) =>
      getStateStore().saveNotificationPreferences(preferences),
  },
) {
  return {
    apply(body: unknown) {
      return {
        preferences: dependencies.save(dependencies.parse(body)),
      };
    },
  };
}

/** Framework-independent notification preferences mutation used by transport adapters. */
export const notificationPreferencesMutationService =
  createNotificationPreferencesMutationService();

export { NotificationInputError };
