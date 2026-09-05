import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectValidation } from "./pull-request";
import { getOrCreateRepoProfile, updateRepoProfile } from "./project-profiles";
import { runGit } from "./git";
import { StateStore, replaceStateStoreForTests } from "./state-store";
import { clearTasksForTests, createTask, getTask, getTaskHistory, reloadTasksFromStoreForTests, resumeTask, transitionTask } from "./tasks";

let root: string;
let allowedRoot: string;
let worktreeRoot: string;
let store: StateStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "multiagents-profile-"));
  allowedRoot = join(root, "code"); worktreeRoot = join(root, "worktrees");
  await mkdir(join(allowedRoot, "project"), { recursive: true });
  await runGit(join(allowedRoot, "project"), ["init", "-b", "main"]);
  await runGit(join(allowedRoot, "project"), ["config", "user.email", "test@example.com"]);
  await runGit(join(allowedRoot, "project"), ["config", "user.name", "Test"]);
  await writeFile(join(allowedRoot, "project", "README.md"), "initial\n");
  await runGit(join(allowedRoot, "project"), ["add", "README.md"]);
  await runGit(join(allowedRoot, "project"), ["commit", "-m", "initial"]);
  store = new StateStore(join(root, "state.db")); replaceStateStoreForTests(store); clearTasksForTests();
});

afterEach(() => { clearTasksForTests(); replaceStateStoreForTests(new StateStore(":memory:")); });

describe("Phase 10 project profiles", () => {
  it("creates and assigns safe_default, snapshots it, and audits safe IDs", async () => {
    const profile = await getOrCreateRepoProfile("project", allowedRoot);
    const task = await createTask("project", { allowedRoot, worktreeRoot });
    expect(profile.name).toBe("safe_default");
    expect(task.profile).toEqual(expect.objectContaining({ profileId: profile.profileId, version: 1 }));
    expect(getTaskHistory(task.id).events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "profile_snapshot_created", metadata: { profileId: profile.profileId, profileVersion: 1 } })]));
    expect(store.loadProfileAuditEvents().map((event) => event.type)).toEqual(["profile_created", "profile_assigned", "profile_snapshot_created"]);
  });

  it("increments versions while existing tasks keep v1 and new tasks receive v2", async () => {
    const first = await createTask("project", { allowedRoot, worktreeRoot });
    const current = await getOrCreateRepoProfile("project", allowedRoot);
    const updated = await updateRepoProfile("project", { name: "strict_app", enabled: true, roles: current.roles, validation: { ...current.validation, missingScript: "fail", timeout: "extended" } }, allowedRoot);
    const second = await createTask("project", { allowedRoot, worktreeRoot });
    expect(updated.version).toBe(2);
    expect(first.profile).toMatchObject({ name: "safe_default", version: 1 });
    expect(second.profile).toMatchObject({ name: "strict_app", version: 2, validation: { missingScript: "fail", timeout: "extended" } });
    expect(store.loadProfileVersions(current.profileId).map((version) => version.version)).toEqual([1, 2]);
  });

  it("uses snapshot missing-script skip and fail policies", async () => {
    const task = await createTask("project", { allowedRoot, worktreeRoot });
    await writeFile(join(task.worktreePath, "package.json"), JSON.stringify({ scripts: {} }));
    transitionTask(task, "reviewed"); transitionTask(task, "awaiting_approval"); transitionTask(task, "validating");
    const dependencies = { checkDependencies: vi.fn(), runValidation: vi.fn() };
    await runProjectValidation(task, dependencies);
    expect(task.validation.filter((item) => item.status === "skip")).toHaveLength(4);
    task.validation = [];
    task.profile = { ...task.profile!, validation: { ...task.profile!.validation, missingScript: "fail" } };
    await expect(runProjectValidation(task, dependencies)).rejects.toThrow("required by the task profile is missing");
    expect(dependencies.runValidation).not.toHaveBeenCalled();
  });

  it("prevents creation when the human-disabled current profile is selected", async () => {
    const current = await getOrCreateRepoProfile("project", allowedRoot);
    await updateRepoProfile("project", { name: current.name, enabled: false, roles: current.roles, validation: current.validation }, allowedRoot);
    await expect(createTask("project", { allowedRoot, worktreeRoot })).rejects.toThrow("disabled");
  });

  it("classifies a corrupted task profile snapshot as Needs Attention", async () => {
    const task = await createTask("project", { allowedRoot, worktreeRoot });
    const raw = new DatabaseSync(store.path);
    raw.prepare("UPDATE tasks SET profile_snapshot_json = '{}' WHERE task_id = ?").run(task.id);
    raw.close();
    reloadTasksFromStoreForTests();
    await expect(resumeTask(task.id, { allowedRoot, worktreeRoot })).rejects.toThrow("profile snapshot");
    expect(getTask(task.id)).toMatchObject({ recoveryStatus: "needs_attention", profileSnapshotValid: false });
  });
});
