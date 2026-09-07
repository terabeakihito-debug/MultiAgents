import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function secureStateDatabasePath(path: string) {
  if (path === ":memory:") return;
  const parent = dirname(path);
  let parentInfo;
  try { parentInfo = lstatSync(parent); }
  catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    parentInfo = lstatSync(parent);
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error("State database parent must be a regular directory and cannot be a symlink");
  requireOwner(parentInfo.uid, "State database parent");
  if ((parentInfo.mode & 0o777) !== 0o700) chmodSync(parent, 0o700);

  try {
    const fileInfo = lstatSync(path);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Error("State database must be a regular file and cannot be a symlink");
    requireOwner(fileInfo.uid, "State database");
    if ((fileInfo.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function validateSecureRegularFile(path: string, label: string) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file and cannot be a symlink`);
  requireOwner(info.uid, label);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`${label} permissions must be 0600`);
  return info;
}

export function securePrivateDirectory(path: string) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    info = lstatSync(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Managed state directory cannot be a symlink");
  requireOwner(info.uid, "Managed state directory");
  if ((info.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

function requireOwner(uid: number, label: string) {
  const expected = typeof process.getuid === "function" ? process.getuid() : uid;
  if (uid !== expected) throw new Error(`${label} owner does not match the server user`);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
