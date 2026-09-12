import { randomUUID } from "node:crypto";

/**
 * A test-only abstract socket name. Production ownership continues to use
 * the effective-UID identity from server-ownership-socket.mjs.
 */
export function createOwnershipSocketFixtureName(scope: string) {
  return `\0multiagents-test-ownership-${scope}-${process.pid}-${randomUUID()}`;
}
