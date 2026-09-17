import { retentionPresets, type RetentionPreset } from "../operations/types";
import { getStateStore } from "../server/state-store";

type RetentionPolicyMutationDependencies = {
  save: (preset: RetentionPreset) => RetentionPreset;
};

export class RetentionPresetInvalidError extends Error {
  constructor(message = "Retention preset is invalid") {
    super(message);
    this.name = "RetentionPresetInvalidError";
  }
}

export function createRetentionPolicyMutationService(
  dependencies: RetentionPolicyMutationDependencies = {
    save: (preset) => getStateStore().saveRetentionPolicy(preset),
  },
) {
  return {
    apply(body: unknown) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new RetentionPresetInvalidError();
      }
      const preset = (body as { preset?: unknown }).preset;
      if (!retentionPresets.includes(preset as RetentionPreset)) {
        throw new RetentionPresetInvalidError();
      }
      return { preset: dependencies.save(preset as RetentionPreset) };
    },
  };
}

/** Framework-independent retention policy mutation used by transport adapters. */
export const retentionPolicyMutationService =
  createRetentionPolicyMutationService();
