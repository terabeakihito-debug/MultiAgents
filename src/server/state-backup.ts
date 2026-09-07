import { randomUUID } from "node:crypto";
import { access, chmod, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { BackupMetadata } from "../operations/types";
import { APP_STATE_COMPAT, getStateStore, STATE_DIRECTORY, type StateStore } from "./state-store";
import { securePrivateDirectory, validateSecureRegularFile } from "./state-path";

export const BACKUP_DIRECTORY = join(STATE_DIRECTORY, "backups");
const EXPECTED_TABLES = ["schema_version", "tasks", "task_events", "findings", "notifications", "operations", "backup_metadata"] as const;

export async function createStateBackup(options: { store?: StateStore; directory?: string; now?: Date; backupId?: string } = {}) {
  const store = options.store ?? getStateStore();
  if (store.path === ":memory:") throw new BackupValidationError("In-memory state cannot be backed up");
  const directory = options.directory ?? BACKUP_DIRECTORY;
  securePrivateDirectory(directory);
  const backupId = options.backupId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(backupId)) throw new BackupValidationError("Backup ID is invalid");
  const destination = join(directory, `${backupId}.db`);
  const temporary = join(directory, `.${backupId}.tmp`);
  await requireAbsent(destination);
  await requireAbsent(temporary);
  const handle = await open(temporary, "wx", 0o600);
  await handle.close();
  try {
    const source = new DatabaseSync(store.path, { readOnly: true });
    try { await backup(source, temporary); } finally { source.close(); }
    await chmod(temporary, 0o600);
    const verification = validateBackupFile(temporary);
    await rename(temporary, destination);
    const createdAt = (options.now ?? new Date()).toISOString();
    const metadata: BackupMetadata = {
      backupId, createdAt, schemaVersion: verification.schemaVersion, integrityStatus: "ok",
      sizeBytes: validateSecureRegularFile(destination, "Backup file").size,
      appCommit: safeCommit(process.env.MULTIAGENTS_APP_COMMIT),
    };
    store.saveBackupMetadata(metadata);
    return metadata;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function validateStateBackup(backupId: string, options: { store?: StateStore; directory?: string } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(backupId)) throw new BackupValidationError("Backup ID is invalid");
  const store = options.store ?? getStateStore();
  const metadata = store.loadBackups().find((item) => item.backupId === backupId);
  if (!metadata) throw new BackupValidationError("Backup metadata not found");
  const directory = options.directory ?? BACKUP_DIRECTORY;
  securePrivateDirectory(directory);
  const result = validateBackupFile(join(directory, `${backupId}.db`));
  if (result.schemaVersion !== metadata.schemaVersion || result.sizeBytes !== metadata.sizeBytes) throw new BackupValidationError("Backup file does not match its metadata");
  return { ...metadata, verified: true as const };
}

export function validateBackupFile(path: string) {
  const info = validateSecureRegularFile(path, "Backup file");
  let database: DatabaseSync;
  try { database = new DatabaseSync(path, { readOnly: true }); }
  catch { throw new BackupValidationError("Backup is not a readable SQLite database"); }
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    if (String(integrity.integrity_check) !== "ok") throw new BackupValidationError("Backup integrity check failed");
    const row = database.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null };
    const schemaVersion = Number(row.version ?? 0);
    if (schemaVersion < APP_STATE_COMPAT.minSchema || schemaVersion > APP_STATE_COMPAT.maxSchema) throw new BackupValidationError("Backup schema is not supported by this application");
    const names = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((item) => item.name));
    if (EXPECTED_TABLES.some((table) => !names.has(table))) throw new BackupValidationError("Backup is missing required state tables");
    return { integrity: "ok" as const, schemaVersion, sizeBytes: info.size };
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError("Backup validation failed");
  } finally { database.close(); }
}

export function latestVerifiedBackup(store: StateStore = getStateStore(), now = new Date()) {
  const latest = store.loadBackups()[0];
  return latest ? { ...latest, ageHours: Math.max(0, (now.getTime() - Date.parse(latest.createdAt)) / 3_600_000) } : undefined;
}

async function requireAbsent(path: string) {
  try { await access(path); throw new BackupValidationError("Backup target already exists"); }
  catch (error) {
    if (error instanceof BackupValidationError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
function safeCommit(value: string | undefined) { return value && /^[0-9a-f]{7,40}$/i.test(value) ? value : undefined; }
export class BackupValidationError extends Error {}
