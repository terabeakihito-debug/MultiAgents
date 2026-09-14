import { AsyncLocalStorage } from "node:async_hooks";

type ProviderWorkContext = {
  callback: () => void;
  notified: boolean;
};

const providerWorkContext = new AsyncLocalStorage<ProviderWorkContext>();

/** Runs one provider execution with a synchronous provider-work start callback. */
export function withProviderWorkBoundary<T>(callback: () => void, operation: () => T): T {
  return providerWorkContext.run({ callback, notified: false }, operation);
}

/** Called by the production runner after preflight and immediately before provider spawn. */
export function notifyProviderWorkStart() {
  const context = providerWorkContext.getStore();
  if (!context || context.notified) return;
  context.notified = true;
  context.callback();
}
