// This module is deliberately plain ESM so both the TypeScript server and the
// standalone offline-restore script derive the exact same abstract name.
export function getEffectiveUid(processRef = process) {
  if (typeof processRef.geteuid !== "function") throw new Error("Effective UID is unavailable");
  return processRef.geteuid();
}

export function getServerOwnershipSocketName(processRef = process) {
  const testSocketName = processRef.env?.NODE_ENV === "test"
    ? processRef.env.MULTIAGENTS_TEST_OWNERSHIP_SOCKET
    : undefined;
  if (typeof testSocketName === "string" && /^\/tmp\/multiagents-test-ownership-[a-z0-9][a-z0-9-]{0,70}\.sock$/.test(testSocketName)) {
    return testSocketName;
  }
  if (typeof testSocketName === "string" && /^multiagents-test-ownership-[a-z0-9][a-z0-9-]{0,90}$/.test(testSocketName)) {
    return `\0${testSocketName}`;
  }
  return `\0multiagents-server-v1-${getEffectiveUid(processRef)}`;
}
