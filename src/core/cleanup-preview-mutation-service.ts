import { previewCleanup } from "../server/cleanup";

type CleanupPreviewMutationDependencies = {
  preview: typeof previewCleanup;
};

export function createCleanupPreviewMutationService(
  dependencies: CleanupPreviewMutationDependencies = {
    preview: previewCleanup,
  },
) {
  return {
    async apply(body: unknown) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return dependencies.preview([]);
      }
      const candidateIds = (body as { candidateIds?: unknown }).candidateIds;
      const ids = Array.isArray(candidateIds)
        ? (candidateIds as string[])
        : [];
      return dependencies.preview(ids);
    },
  };
}

/** Framework-independent cleanup preview mutation used by transport adapters. */
export const cleanupPreviewMutationService =
  createCleanupPreviewMutationService();
