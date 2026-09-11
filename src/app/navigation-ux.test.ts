import { describe, expect, it } from "vitest";
import { resolveStartTemplate, submitTaskStart, taskStartBlockReason, type StartRepository } from "./task-start";

const templates = [
  { templateId: "review", enabled: true, readOnly: true, requireWorktree: false, requireHumanApproval: false, requirePr: false },
  { templateId: "write", enabled: true, readOnly: false, requireWorktree: true, requireHumanApproval: true, requirePr: true },
  { templateId: "disabled", enabled: false, readOnly: false, requireWorktree: true, requireHumanApproval: true, requirePr: true },
];
const repo = (defaultTemplateId = "write", enabled = templates): StartRepository => ({ templates: enabled, settings: { defaultTemplateId } });

describe("natural task start behavior", () => {
  it("uses the enabled configured default without a manual template choice", () => {
    expect(resolveStartTemplate(repo()).template?.templateId).toBe("write");
    expect(resolveStartTemplate(repo()).source).toBe("default");
  });

  it("falls back to the sole enabled template when the configured default is disabled or absent", () => {
    expect(resolveStartTemplate(repo("disabled", [templates[0]])).template?.templateId).toBe("review");
    expect(resolveStartTemplate(repo("missing", [templates[0]])).template?.templateId).toBe("review");
  });

  it("requires a choice when several enabled templates have no valid default", () => {
    expect(resolveStartTemplate(repo("missing")).source).toBe("selection_required");
  });

  it("does not resolve or submit a disabled-only template set", () => {
    expect(resolveStartTemplate(repo("disabled", [templates[2]])).source).toBe("none_enabled");
  });

  it("uses a valid explicit override and ignores one that becomes disabled", () => {
    expect(resolveStartTemplate(repo(), "review")).toMatchObject({ source: "override", template: { templateId: "review" } });
    expect(resolveStartTemplate(repo("write", [templates[1], templates[2]]), "review")).toMatchObject({ source: "default", template: { templateId: "write" } });
  });

  it("does not retain an override from a different repository", () => {
    expect(resolveStartTemplate(repo("review"), undefined)).toMatchObject({ source: "default", template: { templateId: "review" } });
  });

  it("immediately follows a Settings default change while no override exists", () => {
    expect(resolveStartTemplate(repo("review")).template?.templateId).toBe("review");
    expect(resolveStartTemplate(repo("write")).template?.templateId).toBe("write");
  });

  it("keeps profile, initialization, repair, and empty-prompt starts blocked with distinct reasons", () => {
    const valid = { hasRepository: true, prompt: "確認してください", hasTemplate: true, profileEnabled: true, initializationRequired: false, initializationRepairRequired: false, selectionRequired: false };
    expect(taskStartBlockReason({ ...valid, profileEnabled: false })).toBe("profile_disabled");
    expect(taskStartBlockReason({ ...valid, initializationRequired: true })).toBe("initialization_required");
    expect(taskStartBlockReason({ ...valid, initializationRepairRequired: true })).toBe("repair_required");
    expect(taskStartBlockReason({ ...valid, prompt: "  " })).toBe("empty_prompt");
    expect(taskStartBlockReason({ ...valid, hasTemplate: false })).toBe("no_template");
  });

  it("blocks duplicate submissions while preserving the prompt for retry after failure", async () => {
    const lock = { current: false };
    const busy: boolean[] = [];
    const errors: string[] = [];
    let requests = 0;
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((_, nextReject) => { reject = nextReject; });
    const form = { repoId: "repo-1", templateId: "review", explicitOverrideId: "review", prompt: "ログイン画面を修正してください" };
    const options = {
      acquire: () => { if (lock.current) return false; lock.current = true; return true; },
      release: () => { lock.current = false; }, setBusy: (value: boolean) => busy.push(value), clearError: () => errors.splice(0), setError: (value: string) => errors.push(value),
      form,
      request: (submitted: Readonly<{ repoId: string; templateId: string; explicitOverrideId?: string; prompt: string }>) => { requests += 1; expect(submitted).toEqual(form); return pending; },
    };
    const first = submitTaskStart(options);
    expect(busy).toEqual([true]);
    expect(await submitTaskStart(options)).toBe(false);
    expect(requests).toBe(1);
    reject(new Error("開始できませんでした"));
    await expect(first).resolves.toBe(false);
    expect(busy).toEqual([true, false]);
    expect(errors).toEqual(["開始できませんでした"]);
    expect(form).toEqual({ repoId: "repo-1", templateId: "review", explicitOverrideId: "review", prompt: "ログイン画面を修正してください" });
    await expect(submitTaskStart({ ...options, request: async (submitted: Readonly<{ repoId: string; templateId: string; explicitOverrideId?: string; prompt: string }>) => { requests += 1; expect(submitted.prompt).toBe("ログイン画面を修正してください"); } })).resolves.toBe(true);
    expect(requests).toBe(2);
  });
});
