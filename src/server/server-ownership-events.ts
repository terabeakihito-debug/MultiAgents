type OwnershipLossListener = () => void;
const shared = globalThis as typeof globalThis & { __multiAgentsOwnershipLossListeners?: Set<OwnershipLossListener> };
const listeners = shared.__multiAgentsOwnershipLossListeners ??= new Set<OwnershipLossListener>();

export function onServerOwnershipLost(listener: OwnershipLossListener) { listeners.add(listener); return () => listeners.delete(listener); }
export function notifyServerOwnershipLost() { for (const listener of listeners) { try { listener(); } catch { /* one observer cannot suppress terminal loss */ } } }
