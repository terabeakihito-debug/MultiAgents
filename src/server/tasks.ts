import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { runGit } from "./git";
import { validateRepository } from "./repositories";

export const WORKTREE_ROOT = join(homedir(), "code", ".multiagents-worktrees");
export type RepoTask = { id: string; repoId: string; repoName: string; repoPath: string; branch: string; worktreePath: string; worktreeRoot: string };
export type TaskDiff = { trackedFiles: string[]; untrackedFiles: string[]; stat: string; patch: string; untrackedPatch: string; truncated: boolean };
export const MAX_UNTRACKED_FILE_BYTES = 100_000;
export const MAX_UNTRACKED_TOTAL_BYTES = 500_000;
const MAX_UNTRACKED_FILES = 1_000;
const EXCLUDED_PARTS = new Set([".git", ".next", "node_modules"]);
const tasks = new Map<string, RepoTask>();

export async function createTask(repoId: string, options: { allowedRoot?: string; worktreeRoot?: string } = {}): Promise<RepoTask> {
  const repo = await validateRepository(repoId, options.allowedRoot);
  if (repo.dirty) throw new Error("Repository has uncommitted changes. Commit or stash them before creating a worktree.");
  const id = randomUUID();
  const branch = `multiagents/${id}`;
  const worktreeRoot = options.worktreeRoot ?? WORKTREE_ROOT;
  const parent = join(worktreeRoot, repo.id);
  const worktreePath = join(parent, id);
  await mkdir(parent, { recursive: true });
  await runGit(repo.path, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  const task = { id, repoId: repo.id, repoName: repo.name, repoPath: repo.path, branch, worktreePath, worktreeRoot };
  tasks.set(id, task);
  return task;
}

export function getTask(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return tasks.get(id);
}

export async function getTaskDiff(task: RepoTask): Promise<TaskDiff> {
  const root = await realpath(task.worktreePath);
  const [statOutput, patch, trackedOutput, untrackedOutput] = await Promise.all([
    runGit(root, ["diff", "--stat"]),
    runGit(root, ["diff", "--no-ext-diff", "--"]),
    runGit(root, ["diff", "--name-only", "--"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const trackedFiles = trackedOutput ? trackedOutput.split("\n") : [];
  const allCandidates = untrackedOutput.split("\0").filter(Boolean).filter((name) => !name.split(/[\\/]/).some((part) => EXCLUDED_PARTS.has(part)));
  const candidates = allCandidates.slice(0, MAX_UNTRACKED_FILES);
  const sections: string[] = [];
  const untrackedFiles: string[] = [];
  let totalBytes = 0;
  let truncated = allCandidates.length > candidates.length;
  for (const name of candidates) {
    const path = join(root, name);
    const info = await lstat(path);
    const nameBytes = Buffer.byteLength(name, "utf8");
    if (totalBytes + nameBytes > MAX_UNTRACKED_TOTAL_BYTES) { truncated = true; break; }
    totalBytes += nameBytes;
    if (info.isSymbolicLink()) { untrackedFiles.push(name); sections.push(`Untracked symlink (content omitted): ${JSON.stringify(name)}`); continue; }
    if (!info.isFile()) continue;
    const target = await realpath(path);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    untrackedFiles.push(name);
    if (totalBytes >= MAX_UNTRACKED_TOTAL_BYTES) { truncated = true; sections.push(`Untracked file omitted by total display limit: ${JSON.stringify(name)}`); continue; }
    const allowance = Math.min(MAX_UNTRACKED_FILE_BYTES, MAX_UNTRACKED_TOTAL_BYTES - totalBytes);
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(allowance + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, Math.min(bytesRead, allowance));
      totalBytes += data.length;
      const limited = bytesRead > allowance || info.size > allowance;
      if (limited) truncated = true;
      let body: string;
      try { body = new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch { sections.push(`Binary/untracked file (content omitted): ${JSON.stringify(name)}`); continue; }
      if (data.includes(0)) { sections.push(`Binary/untracked file (content omitted): ${JSON.stringify(name)}`); continue; }
      const lines = body.split("\n").map((line) => `+${line}`).join("\n");
      sections.push(`diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ untracked file @@\n${lines}${limited ? "\n[untracked file truncated]" : ""}`);
    } finally { await handle.close(); }
  }
  return { trackedFiles, untrackedFiles, stat: statOutput, patch, untrackedPatch: sections.join("\n\n"), truncated };
}

export async function deleteTask(id: string) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (await runGit(task.worktreePath, ["status", "--porcelain"])) throw new Error("Task worktree has uncommitted changes and cannot be deleted");
  const root = await realpath(task.worktreeRoot);
  const target = await realpath(task.worktreePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Invalid worktree path");
  await runGit(task.repoPath, ["worktree", "remove", task.worktreePath]);
  tasks.delete(id);
}

export function clearTasksForTests() { tasks.clear(); }
