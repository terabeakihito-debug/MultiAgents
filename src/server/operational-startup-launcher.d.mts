export type StartupBridge = {
  cancelled?: boolean;
  abort?: () => Promise<void>;
  setAbort?: (abort: () => Promise<void>) => void;
};

export const STATIC_UI_BUILD_REQUIRED_MESSAGE: string;

export function assertStaticUiBuildAvailable(options: {
  staticUiActive: boolean;
}): void;

export function runOperationalStartupFromLauncher(
  startupBridge?: StartupBridge,
): Promise<void>;
