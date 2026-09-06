import { realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { runGit } from "./git";

export const ALLOWED_ROOT = join(homedir(), "code");
export type Repository = { id: string; name: string; branch: string; dirty: boolean };
export type ValidatedRepository = Repository & { path: string };

function isWithin(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !/^\/mnt\/[a-z](?:\/|$)/i.test(resolve(candidate));
}

export async function validateRepository(id: string, root = ALLOWED_ROOT): Promise<ValidatedRepository> {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error("Invalid repository id");
  const realRoot = await realpath(root);
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(realRoot)) throw new Error("Windows mounted drives cannot be repository roots");
  const candidate = await realpath(join(realRoot, id));
  if (!isWithin(realRoot, candidate)) throw new Error("Repository is outside the allowed root");
  if (!(await stat(candidate)).isDirectory()) throw new Error("Repository is not a directory");
  const top = await realpath(await runGit(candidate, ["rev-parse", "--show-toplevel"]));
  if (top !== candidate) throw new Error("Repository must be a Git working tree rooted directly under ~/code");
  const branch = await runGit(candidate, ["branch", "--show-current"]);
  if (!branch) throw new Error("Detached HEAD repositories are not supported");
  const dirty = Boolean(await runGit(candidate, ["status", "--porcelain"]));
  return { id, name: basename(candidate), path: candidate, branch, dirty };
}

export async function listRepositories(root = ALLOWED_ROOT): Promise<Repository[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const repos = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
    try { const repo = await validateRepository(entry.name, root); return { id: repo.id, name: repo.name, branch: repo.branch, dirty: repo.dirty }; } catch { return undefined; }
  }));
  return repos.filter((repo): repo is Repository => Boolean(repo)).sort((a, b) => a.name.localeCompare(b.name));
}
