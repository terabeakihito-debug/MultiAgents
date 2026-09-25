import type { IncomingMessage, ServerResponse } from "node:http";

export function resolvePathUnderRoot(root: string, relativePath: string): string | null;
export const viteAppHtmlFiles: Record<string, string>;
export function mapPathnameToViteAsset(pathname: string): string | null;
export function mapPathnameToViteAppHtml(pathname: string): string | null;
export function isViteAppHtmlPath(htmlPath: string): boolean;
export function parseRequestPathname(request: IncomingMessage): string;

export function createNextStaticUiBridge(): {
  isActive(): Promise<boolean>;
  tryHandle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
};
