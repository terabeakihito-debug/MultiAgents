import policy from "./state-schema-compatibility.json";

export const CURRENT_SCHEMA_VERSION = policy.currentSchemaVersion;
export const MIN_MIGRATABLE_SCHEMA_VERSION = policy.minMigratableSchemaVersion;
export const MAX_SUPPORTED_SCHEMA_VERSION = policy.maxSupportedSchemaVersion;
export const APP_STATE_COMPAT = Object.freeze({ minSchema: MIN_MIGRATABLE_SCHEMA_VERSION, maxSchema: MAX_SUPPORTED_SCHEMA_VERSION });

export type SchemaCompatibility = "current" | "migratable" | "too_old" | "future" | "incomplete_migration";
export function schemaCompatibility(version: number): SchemaCompatibility {
  if (version < MIN_MIGRATABLE_SCHEMA_VERSION) return "too_old";
  if (version > MAX_SUPPORTED_SCHEMA_VERSION) return "future";
  if (version === CURRENT_SCHEMA_VERSION) return "current";
  return hasCompleteMigrationPath(version) ? "migratable" : "incomplete_migration";
}
export function hasCompleteMigrationPath(version: number) {
  for (let next = version + 1; next <= CURRENT_SCHEMA_VERSION; next++) if (!policy.migrationSteps.includes(next)) return false;
  return true;
}
export function requiredTablesForSchema(version: number) {
  return policy.requiredTables[String(version) as keyof typeof policy.requiredTables] ?? [];
}
