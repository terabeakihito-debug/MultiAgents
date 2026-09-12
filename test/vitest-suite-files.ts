export const heavyVitestFiles = [
  "src/server/cleanup.test.ts",
  "src/server/state-store.test.ts",
  "src/server/worktree-reassociation.test.ts",
  "src/server/operational-reliability.test.ts",
  "src/server/child-process-registry.test.ts",
  "src/server/notifications.test.ts",
  "src/server/outbound-notifications.test.ts",
  "src/server/credential-resolver.test.ts",
  "src/server/project-profiles.test.ts",
  "src/server/remediation-queue.test.ts",
] as const;

export function splitVitestFiles(testFiles: readonly string[]) {
  const heavy = testFiles.filter((testFile) => heavyVitestFiles.includes(testFile as typeof heavyVitestFiles[number]));
  const light = testFiles.filter((testFile) => !heavyVitestFiles.includes(testFile as typeof heavyVitestFiles[number]));
  return { heavy, light };
}
