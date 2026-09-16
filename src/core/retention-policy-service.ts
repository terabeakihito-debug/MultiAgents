import type { RetentionPreset } from "../operations/types";
import { getStateStore } from "../server/state-store";

type RetentionPolicyDependencies = {
  loadPreset: () => RetentionPreset;
};

export function createRetentionPolicyService(dependencies: RetentionPolicyDependencies = {
  loadPreset: () => getStateStore().loadRetentionPolicy(),
}) {
  return {
    load() {
      return { preset: dependencies.loadPreset() };
    },
  };
}

/** Framework-independent retention policy read boundary used by transport adapters. */
export const retentionPolicyService = createRetentionPolicyService();
