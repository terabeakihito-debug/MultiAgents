import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const launcherRoot = dirname(fileURLToPath(import.meta.url));
const operationalStartupPath = join(
  launcherRoot,
  "../../dist-daemon/server/operational-startup.js",
);

export function shouldPrepareNextApp({ development, staticUiActive }) {
  return development || !staticUiActive;
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
