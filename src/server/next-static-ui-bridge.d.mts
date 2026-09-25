import type { IncomingMessage, ServerResponse } from "node:http";

export function resolvePathUnderRoot(root: string, relativePath: string): string | null;
export function mapPathnameToAppHtml(pathname: string): string;
export function mapPathnameToStaticAsset(pathname: string): string | null;
export function mapPathnameToViteAsset(pathname: string): string | null;
export function mapPathnameToViteAppHtml(pathname: string): string | null;
export function parseRequestPathname(request: IncomingMessage): string;

export function createNextStaticUiBridge(): {
  isActive(): Promise<boolean>;
  tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
};
