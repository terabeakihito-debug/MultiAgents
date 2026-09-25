export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Custom launcher runs operational startup before prepare.  Instrumentation
  // remains for stock Next entrypoints and is a no-op once the launcher reports
  // readiness.
  const bridge = (globalThis as typeof globalThis & Record<symbol, {
    cancelled?: boolean;
    operationalReady?: boolean;
    ready?: () => void;
    failed?: (error: unknown) => void;
    setAbort?: (abort: () => Promise<void>) => void;
  } | undefined>)[Symbol.for("multiagents.launcher-startup.v1")];
  if (bridge?.operationalReady) return;
  if (bridge?.cancelled) throw new Error("Launcher cancelled before operational startup");
  const { abortOperationalStartup, initializeOperationalStartup } = await import("./server/operational-startup");
  bridge?.setAbort?.(abortOperationalStartup);
  try {
    await initializeOperationalStartup();
    bridge?.ready?.();
  } catch (error) {
    bridge?.failed?.(error);
    // The custom launcher owns reporting/exit and has already received the
    // failure.  Re-throw only for the stock Next path, which has no launcher
    // handoff to observe.
    if (bridge) return;
    throw error;
  }
}
