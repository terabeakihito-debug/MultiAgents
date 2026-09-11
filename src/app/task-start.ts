export type StartTemplate = {
  templateId: string;
  enabled: boolean;
  readOnly: boolean;
  requireWorktree: boolean;
  requireHumanApproval: boolean;
  requirePr: boolean;
};

export type StartRepository = {
  templates: StartTemplate[];
  settings: { defaultTemplateId: string };
};

export type ResolvedStartTemplate = {
  template?: StartTemplate;
  source: "override" | "default" | "only_enabled" | "selection_required" | "none_enabled";
};

export function taskStartBlockReason(input: {
  hasRepository: boolean;
  prompt: string;
  hasTemplate: boolean;
  profileEnabled: boolean;
  initializationRequired: boolean;
  initializationRepairRequired: boolean;
  selectionRequired: boolean;
}): "no_repository" | "empty_prompt" | "no_template" | "profile_disabled" | "initialization_required" | "repair_required" | "selection_required" | undefined {
  if (!input.hasRepository) return "no_repository";
  if (input.initializationRepairRequired) return "repair_required";
  if (input.initializationRequired) return "initialization_required";
  if (!input.profileEnabled) return "profile_disabled";
  if (input.selectionRequired) return "selection_required";
  if (!input.hasTemplate) return "no_template";
  if (!input.prompt.trim()) return "empty_prompt";
  return undefined;
}

export function resolveStartTemplate(repo: StartRepository | undefined, explicitOverrideId?: string): ResolvedStartTemplate {
  if (!repo) return { source: "none_enabled" };
  const enabled = repo.templates.filter((template) => template.enabled);
  const explicit = explicitOverrideId ? enabled.find((template) => template.templateId === explicitOverrideId) : undefined;
  if (explicit) return { template: explicit, source: "override" };
  const configuredDefault = enabled.find((template) => template.templateId === repo.settings.defaultTemplateId);
  if (configuredDefault) return { template: configuredDefault, source: "default" };
  if (enabled.length === 1) return { template: enabled[0], source: "only_enabled" };
  return { source: enabled.length ? "selection_required" : "none_enabled" };
}

export type TaskStartSubmissionOptions = {
  form: Readonly<{ repoId: string; templateId: string; prompt: string; explicitOverrideId?: string }>;
  acquire: () => boolean;
  release: () => void;
  setBusy: (busy: boolean) => void;
  clearError: () => void;
  setError: (error: string) => void;
  request: (form: Readonly<{ repoId: string; templateId: string; prompt: string; explicitOverrideId?: string }>) => Promise<void>;
};

export async function submitTaskStart({ form, acquire, release, setBusy, clearError, setError, request }: TaskStartSubmissionOptions) {
  if (!acquire()) return false;
  setBusy(true);
  clearError();
  try {
    await request(form);
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : "タスクの開始に失敗しました。");
    return false;
  } finally {
    release();
    setBusy(false);
  }
}
