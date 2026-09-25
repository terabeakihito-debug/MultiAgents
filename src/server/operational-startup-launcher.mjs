import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const launcherRoot = dirname(fileURLToPath(import.meta.url));
const operationalStartupPath = join(
  launcherRoot,
  "../../dist-daemon/server/operational-startup.js",
);

export const STATIC_UI_BUILD_REQUIRED_MESSAGE =
  "Static UI build output is missing. Run `npm run build` before `npm run dev` or `npm start`.";

export function assertStaticUiBuildAvailable({ staticUiActive }) {
  if (!staticUiActive) {
    throw new Error(STATIC_UI_BUILD_REQUIRED_MESSAGE);
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
  await initializeOperationalStartup();
}
