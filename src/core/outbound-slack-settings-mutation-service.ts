import {
  OutboundInputError,
  parseOutboundChannelConfig,
} from "../server/outbound-notifications";
import { getStateStore } from "../server/state-store";
import { outboundSlackSettingsService } from "./outbound-slack-settings-service";

type OutboundSlackSettingsMutationDependencies = {
  parse: typeof parseOutboundChannelConfig;
  save: ReturnType<typeof getStateStore>["saveOutboundChannelConfig"];
  loadConfigured: () => boolean;
};

export function createOutboundSlackSettingsMutationService(
  dependencies: OutboundSlackSettingsMutationDependencies = {
    parse: parseOutboundChannelConfig,
    save: (config) => getStateStore().saveOutboundChannelConfig(config),
    loadConfigured: () => outboundSlackSettingsService.load().configured,
  },
) {
  return {
    apply(body: unknown) {
      const config = dependencies.save(dependencies.parse(body));
      return {
        configured: dependencies.loadConfigured(),
        config,
      };
    },
  };
}

/** Framework-independent outbound Slack settings mutation used by transport adapters. */
export const outboundSlackSettingsMutationService =
  createOutboundSlackSettingsMutationService();

export { OutboundInputError };
