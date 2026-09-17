import type { HumanMutationAction } from "../security/human-actions";
import { requireHumanMutation } from "../server/request-security";

type HumanMutationGateDependencies = {
  require: typeof requireHumanMutation;
};

export function createHumanMutationGateService(
  dependencies: HumanMutationGateDependencies = {
    require: requireHumanMutation,
  },
) {
  return {
    reject(
      request: Request,
      expectedAction: HumanMutationAction,
      options: {
        method?: "POST" | "DELETE";
        label?: string;
        now?: number;
      } = {},
    ) {
      return dependencies.require(request, expectedAction, options);
    },
  };
}

/** Framework-independent human mutation gate used by transport adapters. */
export const humanMutationGateService = createHumanMutationGateService();
