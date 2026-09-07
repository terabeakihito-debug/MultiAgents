import { databaseReadiness } from "./operational-health";
import { providerDiagnostics } from "./provider-diagnostics";
import { installServerLifecycle } from "./server-lifecycle";
import { initializeTaskRecovery } from "./tasks";

let startup: Promise<void> | undefined;

export function initializeOperationalStartup() {
  startup ??= (async () => {
    await installServerLifecycle();
    databaseReadiness();
    await initializeTaskRecovery();
    await providerDiagnostics();
  })();
  return startup;
}

export function resetOperationalStartupForTests() { startup = undefined; }
