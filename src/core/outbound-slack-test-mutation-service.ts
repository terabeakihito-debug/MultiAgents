import {
  OutboundInputError,
  sendFixedSlackTest,
} from "../server/outbound-notifications";

type OutboundSlackTestMutationDependencies = {
  send: typeof sendFixedSlackTest;
};

export type OutboundSlackTestMutationResult =
  | { outcome: "delivered"; body: { status: "delivered" } }
  | {
      outcome: "failed";
      body: { error: "Slack test delivery failed"; status: "failed" };
    };

export function createOutboundSlackTestMutationService(
  dependencies: OutboundSlackTestMutationDependencies = {
    send: sendFixedSlackTest,
  },
) {
  return {
    async apply(): Promise<OutboundSlackTestMutationResult> {
      const result = await dependencies.send();
      if (result.delivered) {
        return {
          outcome: "delivered",
          body: { status: "delivered" },
        };
      }
      return {
        outcome: "failed",
        body: {
          error: "Slack test delivery failed",
          status: "failed",
        },
      };
    },
  };
}

/** Framework-independent outbound Slack test mutation used by transport adapters. */
export const outboundSlackTestMutationService =
  createOutboundSlackTestMutationService();

export { OutboundInputError };
