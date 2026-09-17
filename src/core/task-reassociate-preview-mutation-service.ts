import { previewManagedWorktreeReassociation } from "../server/tasks";

type TaskReassociatePreviewMutationDependencies = {
  preview: typeof previewManagedWorktreeReassociation;
};

export function createTaskReassociatePreviewMutationService(
  dependencies: TaskReassociatePreviewMutationDependencies = {
    preview: previewManagedWorktreeReassociation,
  },
) {
  return {
    async apply(taskId: string) {
      const preview = await dependencies.preview(taskId);
      return { preview };
    },
  };
}

/** Framework-independent task reassociate preview mutation used by transport adapters. */
export const taskReassociatePreviewMutationService =
  createTaskReassociatePreviewMutationService();
