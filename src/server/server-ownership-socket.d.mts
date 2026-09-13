export function getEffectiveUid(processRef?: { geteuid?: () => number }): number;
export function getServerOwnershipSocketName(processRef?: {
  geteuid?: () => number;
  env?: { NODE_ENV?: string; MULTIAGENTS_TEST_OWNERSHIP_SOCKET?: string };
}): string;
