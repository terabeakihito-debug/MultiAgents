import { outboundSettingsView } from "../server/outbound-notifications";

type OutboundSlackSettingsDependencies = {
  loadView: typeof outboundSettingsView;
};

export function createOutboundSlackSettingsService(dependencies: OutboundSlackSettingsDependencies = {
  loadView: outboundSettingsView,
}) {
  return {
    load() {
      return dependencies.loadView();
    },
  };
}

/** Framework-independent outbound Slack settings read boundary used by transport adapters. */
export const outboundSlackSettingsService = createOutboundSlackSettingsService();
