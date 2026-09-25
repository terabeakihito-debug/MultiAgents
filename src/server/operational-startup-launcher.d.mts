export type StartupBridge = {
  cancelled?: boolean;
  ready?: () => void;
  failed?: (error: unknown) => void;
  setAbort?: (abort: () => Promise<void>) => void;
};

export function shouldPrepareNextApp(options: {
  development: boolean;
  staticUiActive: boolean;
}): boolean;

export function runOperationalStartupFromLauncher(
  startupBridge?: StartupBridge,
): Promise<void>;
