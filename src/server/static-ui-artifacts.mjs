import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const viteUiRoot = join(projectRoot, "dist-ui");
export const viteUiIndexHtmlPath = join(viteUiRoot, "index.html");
export const viteUiNotFoundHtmlPath = join(viteUiRoot, "404.html");

export async function isViteUiBuildAvailable() {
  try {
    await access(viteUiIndexHtmlPath);
    return true;
  } catch {
    return false;
  }
}

export async function isStaticUiBuildAvailable() {
  return isViteUiBuildAvailable();
}
