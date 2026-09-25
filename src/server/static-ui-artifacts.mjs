import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const staticUiIndexHtmlPath = join(projectRoot, ".next/server/app/index.html");

export async function isStaticUiBuildAvailable() {
  try {
    await access(staticUiIndexHtmlPath);
    return true;
  } catch {
    return false;
  }
}
