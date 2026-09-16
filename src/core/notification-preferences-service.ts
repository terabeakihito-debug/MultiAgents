import { getStateStore } from "../server/state-store";

type NotificationPreferencesDependencies = {
  loadPreferences: () => ReturnType<ReturnType<typeof getStateStore>["loadNotificationPreferences"]>;
};

export function createNotificationPreferencesService(dependencies: NotificationPreferencesDependencies = {
  loadPreferences: () => getStateStore().loadNotificationPreferences(),
}) {
  return {
    load() {
      return { preferences: dependencies.loadPreferences() };
    },
  };
}

/** Framework-independent notification preferences read boundary used by transport adapters. */
export const notificationPreferencesService = createNotificationPreferencesService();
