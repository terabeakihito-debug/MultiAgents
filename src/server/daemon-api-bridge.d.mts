import type { IncomingMessage, ServerResponse } from "node:http";

export function stripApiPrefixFromRequestUrl(request: IncomingMessage): boolean;
export function isDaemonApiBridgeEnabled(): boolean;

type DaemonApiBridgeOptions = {
  loadHandler?: () => Promise<
    (request: IncomingMessage, response: ServerResponse) => Promise<void>
  >;
};

export function createDaemonApiBridge(
  options?: DaemonApiBridgeOptions,
): {
  isEnabled(): boolean;
  tryHandle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean>;
};
