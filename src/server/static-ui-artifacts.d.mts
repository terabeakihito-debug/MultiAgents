export const viteUiRoot: string;
export const viteUiIndexHtmlPath: string;
export const viteUiNotFoundHtmlPath: string;

export function isViteUiBuildAvailable(): Promise<boolean>;
export function isStaticUiBuildAvailable(): Promise<boolean>;
