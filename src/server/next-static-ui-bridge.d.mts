import type { IncomingMessage, ServerResponse } from "node:http";

export function resolvePathUnderRoot(root: string, relativePath: string): string | null;
export function mapPathnameToAppHtml(pathname: string): string;
export function mapPathnameToStaticAsset(pathname: string): string | null;
export function parseRequestPathname(request: IncomingMessage): string;

type NextStaticUiBridgeOptions = {
  development?: boolean;
};

export function createNextStaticUiBridge(
  options?: NextStaticUiBridgeOptions,
): {
  isActive(): Promise<boolean>;
  shouldFallbackToNextHandler(): boolean;
  tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
};
