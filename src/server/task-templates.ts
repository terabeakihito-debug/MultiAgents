import { builtInTemplate, builtInTemplates, mergeTemplateWithProfile, snapshotTemplate, taskTypes, type TaskTemplate } from "../templates/policy";
import type { ProjectProfileSnapshot } from "../profiles/policy";
import { getStateStore } from "./state-store";
import { validateRepository } from "./repositories";

export type TemplateSettingsUpdate = {
  templateId?: string;
  enabled?: boolean;
  defaultTemplateId?: string;
};

export async function getOrCreateRepoTemplates(repoId: string, allowedRoot?: string) {
  await validateRepository(repoId, allowedRoot);
  const store = getStateStore();
  let templates = store.loadRepoTemplates(repoId);
  if (!templates.length) {
    templates = builtInTemplates(repoId);
    store.createRepoTemplates(repoId, templates);
  }
  const normalized = templates.map(normalizeStoredTemplate);
  const settings = store.loadRepoTemplateSettings(repoId);
  if (!settings) throw new Error("Repository task template settings are missing");
  return { templates: normalized, settings };
}

export async function selectTaskTemplate(repoId: string, requestedTemplateId: string | undefined, profile: ProjectProfileSnapshot, allowedRoot?: string) {
  const { templates, settings } = await getOrCreateRepoTemplates(repoId, allowedRoot);
  const templateId = requestedTemplateId ?? settings.defaultTemplateId;
  if (!taskTypes.includes(templateId as (typeof taskTypes)[number])) throw new Error("Task template is not allowlisted");
  const template = templates.find((item) => item.templateId === templateId);
  if (!template) throw new Error("Task template does not belong to this repository");
  if (!template.enabled) throw new Error("Task template is disabled");
  return mergeTemplateWithProfile(snapshotTemplate(template), profile);
}

export async function updateRepoTemplateSettings(repoId: string, input: TemplateSettingsUpdate, allowedRoot?: string) {
  const current = await getOrCreateRepoTemplates(repoId, allowedRoot);
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !["templateId", "enabled", "defaultTemplateId"].includes(key))) throw new Error("Task template settings contain a forbidden field");
  const store = getStateStore();
  if (input.templateId !== undefined || input.enabled !== undefined) {
    if (typeof input.templateId !== "string" || typeof input.enabled !== "boolean" || input.defaultTemplateId !== undefined) throw new Error("Enable/disable requires exactly a templateId and enabled state");
    const selected = current.templates.find((template) => template.templateId === input.templateId);
    if (!selected) throw new Error("Task template does not belong to this repository");
    if (!input.enabled && current.settings.defaultTemplateId === selected.templateId) throw new Error("Select another default before disabling the current default template");
    if (selected.enabled !== input.enabled) {
      const updated: TaskTemplate = { ...selected, enabled: input.enabled, version: selected.version + 1, updatedAt: new Date().toISOString() };
      store.updateTaskTemplate(updated, ["enabled"]);
    }
  } else {
    if (typeof input.defaultTemplateId !== "string") throw new Error("Default task template is required");
    if (!taskTypes.includes(input.defaultTemplateId as (typeof taskTypes)[number])) throw new Error("Default task template is not allowlisted");
    if (current.settings.defaultTemplateId !== input.defaultTemplateId) store.updateDefaultTemplate(repoId, input.defaultTemplateId);
  }
  return getOrCreateRepoTemplates(repoId, allowedRoot);
}

function normalizeStoredTemplate(template: TaskTemplate): TaskTemplate {
  const definition = builtInTemplate(template.repoId, template.templateId);
  return {
    ...definition,
    version: template.version,
    enabled: template.enabled,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}
