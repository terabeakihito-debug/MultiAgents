// This module is deliberately plain ESM so both the TypeScript server and the
// standalone offline-restore script derive the exact same abstract name.
export function getEffectiveUid(processRef = process) {
  if (typeof processRef.geteuid !== "function") throw new Error("Effective UID is unavailable");
  return processRef.geteuid();
}

export function getServerOwnershipSocketName(processRef = process) {
  return `\0multiagents-server-v1-${getEffectiveUid(processRef)}`;
}
