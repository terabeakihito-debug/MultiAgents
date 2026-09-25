import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const launcherRoot = dirname(fileURLToPath(import.meta.url));
const operationalStartupPath = join(
  launcherRoot,
  "../../dist-daemon/server/operational-startup.js",
);

export const PRODUCTION_STATIC_UI_BUILD_REQUIRED_MESSAGE =
  "Production startup requires a Next static UI build. Run `npm run build` before `npm start`.";

export function shouldPrepareNextApp({ development }) {
  return development;
}

export function assertProductionStaticUiBuild({ development, staticUiActive }) {
  if (!development && !staticUiActive) {
    throw new Error(PRODUCTION_STATIC_UI_BUILD_REQUIRED_MESSAGE);
  }
}

/**
 * @param {import("./operational-startup-launcher.mjs").StartupBridge | undefined} startupBridge
 */
export async function runOperationalStartupFromLauncher(startupBridge) {
  if (startupBridge?.cancelled) {
    throw new Error("Launcher cancelled before operational startup");
  }

  const { abortOperationalStartup, initializeOperationalStartup } = await import(
    operationalStartupPath
  );
  startupBridge?.setAbort?.(abortOperationalStartup);
  try {
    await initializeOperationalStartup();
    startupBridge?.ready?.();
  } catch (error) {
    startupBridge?.failed?.(error);
    throw error;
  }
}
