import type { IncomingMessage, ServerResponse } from "node:http";

export function stripApiPrefixFromRequestUrl(request: IncomingMessage): boolean;
export function isDaemonApiBridgeEnabled(devMode?: boolean): boolean;

type DaemonApiBridgeOptions = {
  devMode?: boolean;
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
