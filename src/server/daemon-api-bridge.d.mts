import type { IncomingMessage, ServerResponse } from "node:http";

export function stripApiPrefixFromRequestUrl(request: IncomingMessage): boolean;

type DaemonApiBridgeOptions = {
  loadHandler?: () => Promise<
    (request: IncomingMessage, response: ServerResponse) => Promise<void>
  >;
};

export function createDaemonApiBridge(
  options?: DaemonApiBridgeOptions,
): {
  tryHandle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean>;
};
