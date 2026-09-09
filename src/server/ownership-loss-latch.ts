import process from "node:process";

// The security root is the imported Node process object. It is independent of
// any caller-controlled globalThis binding and survives application reloads.
const ownershipLossKey = "__multiagents_ownership_lost_v1";
let localOwnershipLost = false;
const expectedGetter = () => localOwnershipLost;
const expectedSetter = (value: unknown) => { if (value === true) localOwnershipLost = true; };
const processRecord = process as typeof process & Record<string, unknown>;
const existing = Object.getOwnPropertyDescriptor(processRecord, ownershipLossKey);

if (!existing) {
  Object.defineProperty(processRecord, ownershipLossKey, {
    configurable: false,
    enumerable: false,
    get: expectedGetter,
    set: expectedSetter,
  });
} else if (existing.configurable || typeof existing.get !== "function" || typeof existing.set !== "function") {
  // An unexpected pre-existing descriptor cannot be trusted. Fail closed in
  // this module instance without attempting to overwrite the process object.
  localOwnershipLost = true;
}

export function productionOwnershipLostEver() {
  if (localOwnershipLost) return true;
  const descriptor = Object.getOwnPropertyDescriptor(processRecord, ownershipLossKey);
  if (!descriptor || descriptor.configurable || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") return true;
  try { return descriptor.get.call(process) === true; } catch { return true; }
}

export function markProductionOwnershipLost() {
  localOwnershipLost = true;
  try { processRecord[ownershipLossKey] = true; } catch { /* a locked descriptor remains fail-closed */ }
}
