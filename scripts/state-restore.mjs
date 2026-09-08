import { constants } from "node:fs";
import { chmod, copyFile, lstat, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const backupId = process.argv[2];
if (!backupId || !/^[0-9a-f-]{36}$/i.test(backupId)) fail("Usage: npm run state:restore -- <backup-id>");
const stateDir = join(homedir(), ".multiagents");
const source = join(stateDir, "backups", `${backupId}.db`);
const target = join(stateDir, "state.db");
const temporary = join(stateDir, `.restore-${backupId}.tmp`);
await requireServerStopped(join(stateDir, "server.lock"));
await validate(source);
await rm(temporary, { force: true });
await copyFile(source, temporary, constants.COPYFILE_EXCL);
await chmod(temporary, 0o600);
await validate(temporary);
const retained = join(stateDir, `state.before-restore-${new Date().toISOString().replaceAll(":", "-")}.db`);
let moved = false;
try {
  await rename(target, retained);
  moved = true;
  await rename(temporary, target);
  console.log(`State restored from backup ${backupId}. Previous state retained as ${retained}`);
} catch (error) {
  if (moved) await rename(retained, target).catch(() => undefined);
  await rm(temporary, { force: true });
  throw error;
}

async function validate(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("Backup must be a regular file and cannot be a symlink");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail("Backup owner does not match the current user");
  if ((info.mode & 0o777) !== 0o600) fail("Backup permissions must be 0600");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") fail("Backup integrity check failed");
    const schema = Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get().version ?? 0);
    if (schema < 9 || schema > 13) fail("Backup schema is incompatible with this application");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const name of ["tasks", "task_events", "findings", "notifications", "operations", "backup_metadata", "provider_compatibility_snapshots", "provider_compatibility_acknowledgements"]) if (!tables.has(name)) fail(`Backup is missing required table ${name}`);
  } finally { db.close(); }
}

async function requireServerStopped(lockPath) {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) fail("Server lock is invalid; inspect it manually");
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); fail("MultiAgents server is running; restore is offline-only"); }
      catch (error) { if (!(error && error.code === "ESRCH")) throw error; }
    }
  } catch (error) { if (!(error && error.code === "ENOENT")) throw error; }
}
function fail(message) { throw new Error(message); }
