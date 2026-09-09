import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { getServerOwnershipSocketName } from "../src/server/server-ownership-socket.mjs";
import { readFileSync } from "node:fs";

const schemaPolicy = JSON.parse(readFileSync(new URL("../src/server/state-schema-compatibility.json", import.meta.url), "utf8"));

const backupId = process.argv[2];
if (!backupId || !/^[0-9a-f-]{36}$/i.test(backupId)) fail("Usage: npm run state:restore -- <backup-id>");
const stateDir = join(homedir(), ".multiagents");
const source = join(stateDir, "backups", `${backupId}.db`);
const target = join(stateDir, "state.db");
const temporary = join(stateDir, `.restore-${backupId}.tmp`);
await mkdir(join(stateDir, "runtime"), { recursive: true, mode: 0o700 });
const restoreLease = await acquireRestoreLease();
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
} finally { await new Promise((resolve) => restoreLease.close(resolve)); }

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
    if (schema < schemaPolicy.minMigratableSchemaVersion) fail("Backup schema is too old to migrate");
    if (schema > schemaPolicy.maxSupportedSchemaVersion) fail("Backup schema is newer than supported");
    for (let next = schema + 1; next <= schemaPolicy.currentSchemaVersion; next++) if (!schemaPolicy.migrationSteps.includes(next)) fail("Backup migration path is incomplete");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const name of schemaPolicy.requiredTables[String(schema)] ?? []) if (!tables.has(name)) fail(`Backup is missing required table ${name}`);
  } finally { db.close(); }
}

async function acquireRestoreLease() {
  if (process.platform !== "linux") fail("Offline restore requires Linux abstract Unix socket ownership");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen({ path: getServerOwnershipSocketName(), exclusive: true });
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") fail("MultiAgents server is running; restore is offline-only");
    throw error;
  });
  return server;
}
function fail(message) { throw new Error(message); }
