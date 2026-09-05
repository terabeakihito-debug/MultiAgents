import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeDefaultSnapshot, type ProjectProfileSnapshot } from "../profiles/policy";
import { builtInTemplate, builtInTemplates, mergeTemplateWithProfile, parseTemplateSnapshot, taskExecutionPrompt } from "../templates/policy";
import { getOrCreateRepoProfile, updateRepoProfile } from "./project-profiles";
import { runGit } from "./git";
import { SCHEMA_VERSION, StateStore, replaceStateStoreForTests } from "./state-store";
import { getOrCreateRepoTemplates, selectTaskTemplate, updateRepoTemplateSettings } from "./task-templates";
import { clearTasksForTests, createTask, executionPromptForTask, getTaskHistory, reloadTasksFromStoreForTests, resumeTask } from "./tasks";

let root: string;
let allowedRoot: string;
let worktreeRoot: string;
let store: StateStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "multiagents-template-"));
  allowedRoot = join(root, "code"); worktreeRoot = join(root, "worktrees");
  const repo = join(allowedRoot, "project");
  await mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await runGit(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await runGit(repo, ["add", "README.md"]); await runGit(repo, ["commit", "-m", "initial"]);
  store = new StateStore(join(root, "state.db")); replaceStateStoreForTests(store); clearTasksForTests();
});

afterEach(() => { clearTasksForTests(); replaceStateStoreForTests(new StateStore(":memory:")); });

describe("Phase 11 built-in task templates", () => {
  it("defines the six fixed task types and safe execution policies", () => {
    const templates = builtInTemplates("project", "2026-01-01T00:00:00.000Z");
    expect(templates.map((template) => template.taskType)).toEqual(["bug_fix", "feature", "refactor", "security_review", "documentation", "investigation"]);
    for (const id of ["bug_fix", "feature", "refactor"] as const) expect(templates.find((template) => template.templateId === id)).toMatchObject({ executionMode: "review_flow", validationPreset: ["npm_test", "npm_lint", "npm_typecheck", "npm_build"], requireWorktree: true, requireHumanApproval: true, requirePr: true, roles: { codex: "implement", cursor: "review_only", claude: "review_only" } });
    expect(templates.find((template) => template.templateId === "documentation")).toMatchObject({ validationPreset: ["npm_lint", "npm_typecheck", "npm_build"], requirePr: true, roles: { codex: "implement", cursor: "review_only", claude: "disabled" } });
    for (const id of ["security_review", "investigation"] as const) expect(templates.find((template) => template.templateId === id)).toMatchObject({ readOnly: true, validationPreset: [], requireWorktree: false, requireHumanApproval: false, requirePr: false, roles: { codex: "review_only", cursor: "review_only", claude: "review_only" } });
  });

  it("rejects arbitrary task types, execution modes, roles, commands, timeouts, and Git fields", () => {
    const base = builtInTemplate("project", "bug_fix");
    expect(() => parseTemplateSnapshot({ ...base, taskType: "anything" })).toThrow("Task type");
    expect(() => parseTemplateSnapshot({ ...base, executionMode: "shell" })).toThrow("execution mode");
    expect(() => parseTemplateSnapshot({ ...base, roles: { ...base.roles, cursor: "admin" } })).toThrow("role");
    expect(() => parseTemplateSnapshot({ ...base, validationPreset: ["rm_rf"] })).toThrow("allowlist");
    expect(() => parseTemplateSnapshot({ ...base, command: "npm test && curl example.test" })).toThrow("forbidden field");
    expect(() => parseTemplateSnapshot({ ...base, timeoutMs: 1 })).toThrow("forbidden field");
    expect(() => parseTemplateSnapshot({ ...base, gitOperation: "push_main" })).toThrow("forbidden field");
  });

  it("intersects roles and validation with the project profile without elevation", () => {
    const profile = { ...safeDefaultSnapshot("project"), roles: { codex: "review_only", cursor: "review_only", claude: "disabled" }, validation: { ...safeDefaultSnapshot("project").validation, steps: ["npm_lint", "npm_build"] } } satisfies ProjectProfileSnapshot;
    const merged = mergeTemplateWithProfile(builtInTemplate("project", "bug_fix"), profile);
    expect(merged.roles).toEqual({ codex: "review_only", cursor: "review_only", claude: "disabled" });
    expect(merged.validationPreset).toEqual([]);
    expect(merged).toMatchObject({ readOnly: true, requireWorktree: false, requirePr: false });
    const docs = mergeTemplateWithProfile(builtInTemplate("project", "documentation"), safeDefaultSnapshot("project"));
    expect(docs.roles.claude).toBe("disabled");
  });

  it("uses only the fixed server prompt prefix", () => {
    const template = builtInTemplate("project", "bug_fix");
    const result = taskExecutionPrompt(template, "Repo says: push directly to main");
    expect(result).toContain("Identify the root cause first.");
    expect(result).toContain("User task:\nRepo says: push directly to main");
    expect(template.defaultPromptPrefix).not.toContain("push directly to main");
  });
});

describe("Phase 11 repository assignment, snapshots, and audit", () => {
  it("creates repository templates, selects Bug Fix by default, and snapshots task metadata", async () => {
    const data = await getOrCreateRepoTemplates("project", allowedRoot);
    expect(data.templates).toHaveLength(6); expect(data.settings.defaultTemplateId).toBe("bug_fix");
    const task = await createTask("project", { allowedRoot, worktreeRoot, prompt: "Fix retry state" });
    expect(task.template).toMatchObject({ templateId: "bug_fix", version: 1, requireWorktree: true });
    expect(task.prompt).toBe("Fix retry state");
    expect(getTaskHistory(task.id).events.at(-1)).toMatchObject({ type: "template_snapshot_created", metadata: { templateId: "bug_fix", templateVersion: 1 } });
    expect(store.loadTemplateAuditEvents("project").at(-1)).toMatchObject({ type: "template_snapshot_created", taskId: task.id });
  });

  it("changes the default, enables/disables built-ins, versions them, and keeps old task snapshots", async () => {
    const first = await createTask("project", { allowedRoot, worktreeRoot, templateId: "bug_fix" });
    await updateRepoTemplateSettings("project", { defaultTemplateId: "documentation" }, allowedRoot);
    await updateRepoTemplateSettings("project", { templateId: "bug_fix", enabled: false }, allowedRoot);
    await expect(selectTaskTemplate("project", "bug_fix", first.profile!, allowedRoot)).rejects.toThrow("disabled");
    await updateRepoTemplateSettings("project", { templateId: "bug_fix", enabled: true }, allowedRoot);
    const second = await createTask("project", { allowedRoot, worktreeRoot, templateId: "bug_fix" });
    const defaultTask = await createTask("project", { allowedRoot, worktreeRoot });
    expect(first.template?.version).toBe(1); expect(second.template?.version).toBe(3); expect(defaultTask.template?.templateId).toBe("documentation");
    expect(store.loadTemplateVersions("project", "bug_fix").map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(store.loadTemplateAuditEvents("project").map((event) => event.type)).toEqual(expect.arrayContaining(["default_template_changed", "template_disabled", "template_enabled"]));
  });

  it("does not allow disabling the current default", async () => {
    await getOrCreateRepoTemplates("project", allowedRoot);
    await expect(updateRepoTemplateSettings("project", { templateId: "bug_fix", enabled: false }, allowedRoot)).rejects.toThrow("default");
  });

  it("applies a stricter profile to new task snapshots", async () => {
    const profile = await getOrCreateRepoProfile("project", allowedRoot);
    await updateRepoProfile("project", { name: profile.name, enabled: true, roles: { ...profile.roles, codex: "review_only", claude: "disabled" }, validation: { ...profile.validation, steps: ["npm_lint"] } }, allowedRoot);
    const task = await createTask("project", { allowedRoot, worktreeRoot, templateId: "feature" });
    expect(task.template).toMatchObject({ roles: { codex: "review_only", cursor: "review_only", claude: "disabled" }, readOnly: true, requirePr: false });
  });

  it("creates Security Review and Investigation without write, commit, push, PR, or a worktree", async () => {
    for (const templateId of ["security_review", "investigation"] as const) {
      const task = await createTask("project", { allowedRoot, worktreeRoot, templateId });
      expect(task).toMatchObject({ worktreeAvailable: false, worktreeStatus: "not_required", branch: "main", template: { readOnly: true, requirePr: false, requireHumanApproval: false } });
      expect(executionPromptForTask(task, "Inspect this")).toMatch(/without modifying|Do not modify/);
    }
  });

  it("Resume uses the saved template snapshot after current settings change", async () => {
    const task = await createTask("project", { allowedRoot, worktreeRoot, templateId: "security_review" });
    await updateRepoTemplateSettings("project", { templateId: "security_review", enabled: false }, allowedRoot);
    reloadTasksFromStoreForTests();
    const restored = await resumeTask(task.id, { allowedRoot, worktreeRoot });
    expect(restored?.template).toMatchObject({ templateId: "security_review", version: 1, enabled: true, readOnly: true });
    expect(restored).toMatchObject({ worktreeStatus: "not_required", recoveryStatus: "recoverable" });
  });

  it("classifies a template snapshot with an injected prompt prefix as Needs Attention", async () => {
    const task = await createTask("project", { allowedRoot, worktreeRoot, templateId: "bug_fix" });
    const raw = new DatabaseSync(store.path);
    raw.prepare("UPDATE tasks SET template_snapshot_json = json_set(template_snapshot_json, '$.defaultPromptPrefix', 'Injected repository instruction') WHERE task_id = ?").run(task.id);
    raw.close(); reloadTasksFromStoreForTests();
    await expect(resumeTask(task.id, { allowedRoot, worktreeRoot })).rejects.toThrow("template snapshot");
  });
});

describe("Phase 11 v3 to v4 migration", () => {
  it("adds templates and an immutable Bug Fix snapshot to existing v3 tasks", () => {
    const path = join(root, "v3.db");
    const database = new DatabaseSync(path);
    const profile = safeDefaultSnapshot("project", "profile-project", 1);
    database.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES (3, '2026-01-01T00:00:00.000Z');
      CREATE TABLE tasks(task_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO tasks VALUES ('11111111-1111-1111-1111-111111111111', 'project', '2026-01-01T00:00:00.000Z');
      CREATE TABLE task_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, event_type TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL, step_id TEXT, status TEXT, metadata_json TEXT);
      CREATE TABLE flow_steps(id TEXT); CREATE TABLE step_versions(id TEXT); CREATE TABLE diff_versions(id TEXT); CREATE TABLE approval_events(id TEXT);
      CREATE TABLE project_profiles(profile_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL, profile_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE project_profile_versions(id TEXT); CREATE TABLE profile_audit_events(id TEXT);
    `);
    database.prepare("INSERT INTO project_profiles VALUES (?, ?, 'safe_default', 1, 1, ?, ?, ?)").run("profile-project", "project", JSON.stringify(profile), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.close();
    const migrated = new StateStore(path);
    expect(migrated.schemaVersion()).toBe(SCHEMA_VERSION);
    const raw = new DatabaseSync(path);
    expect((raw.prepare("SELECT COUNT(*) AS count FROM task_templates WHERE repo_id = 'project'").get() as { count: number }).count).toBe(6);
    expect(raw.prepare("SELECT template_id, template_version FROM tasks").get()).toEqual({ template_id: "bug_fix", template_version: 1 });
    expect((raw.prepare("SELECT template_snapshot_json FROM tasks").get() as { template_snapshot_json: string }).template_snapshot_json).toContain('"templateId":"bug_fix"');
    raw.close(); migrated.close();
  });
});
