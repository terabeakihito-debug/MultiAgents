export type StartupBridge = {
  cancelled?: boolean;
  abort?: () => Promise<void>;
  setAbort?: (abort: () => Promise<void>) => void;
};

export const PRODUCTION_STATIC_UI_BUILD_REQUIRED_MESSAGE: string;

export function shouldPrepareNextApp(options: {
  development: boolean;
}): boolean;

export function assertProductionStaticUiBuild(options: {
  development: boolean;
  staticUiActive: boolean;
}): void;

export function runOperationalStartupFromLauncher(
  startupBridge?: StartupBridge,
): Promise<void>;
