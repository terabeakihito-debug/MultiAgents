import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import authenticProcess from "node:process";
import ts from "typescript";

process.env.NODE_ENV ??= "production";
const root = process.cwd();
function load(name, dependencies = {}) {
  const filename = path.join(root, "src/server", `${name}.ts`);
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const require = compiled.require.bind(compiled);
  compiled.require = (request) => Object.hasOwn(dependencies, request) ? dependencies[request] : require(request);
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return compiled.exports;
}

const lock = load("server-instance-lock");
const ownershipLatch = load("ownership-loss-latch");
const registry = load("operation-registry", { "./ownership-loss-latch": ownershipLatch });
const events = load("server-ownership-events");
const lifecycle = load("server-lifecycle", {
  "./operation-registry": registry,
  "./child-process-registry": { CHILD_PROCESS_GRACE_MS: 1, terminateRegisteredChildren: async () => ({ operationIds: [] }) },
  "./state-store": {},
  "./server-instance-lock": lock,
  "./server-ownership-events": events,
  "./ownership-loss-latch": ownershipLatch,
});
const startup = load("operational-startup", {
  "./operational-health": { databaseReadiness: () => undefined },
  "./provider-diagnostics": { providerDiagnostics: async () => undefined },
  "./server-lifecycle": lifecycle,
  "./tasks": { initializeTaskRecovery: async () => undefined },
  "./server-ownership-events": events,
});

for (const exportsObject of [registry, lifecycle, startup, events, lock]) {
  assert.deepEqual(Object.keys(exportsObject).filter((name) => /(?:reset|ForTests|setMutationOwnershipCheck)/i.test(name)), []);
}
assert.throws(() => registry.beginRegisteredOperation("predicate-missing", "proof"));
const lease = await lifecycle.installServerLifecycle();
lease.server.close();
await lifecycle.abortServerStartup(lease);
assert.equal(registry.ownershipLostEver(), true);
assert.equal(fs.existsSync(path.join(root, "src/server/testing/ownership-state-controls.ts")), false);
const fresh = registry.createOperationRegistryState(() => true);
const legacyRegistryKey = Symbol.for("multiagents.operation-registry.v1");
const coordinatorKey = Symbol.for("multiagents.lifecycle-coordinator.v1");
const lossKey = "__multiagents_ownership_lost_v1";
Object.assign(globalThis[legacyRegistryKey] ?? {}, fresh);
globalThis[legacyRegistryKey] = fresh;
Object.assign(globalThis[coordinatorKey], { installed: true, ownershipLost: false, shutdown: undefined, lease: { isActive: () => true } });
try { authenticProcess[lossKey] = false; } catch { /* terminal descriptor rejects replacement */ }
try { delete authenticProcess[lossKey]; } catch { /* terminal descriptor rejects deletion */ }
try { Object.defineProperty(authenticProcess, lossKey, { value: false }); } catch { /* terminal descriptor rejects redefinition */ }
assert.equal(authenticProcess[lossKey], true);
const fakeProcess = { env: {}, on() {}, once() {}, off() {} };
try { globalThis.process = fakeProcess; } catch { /* runtime may reject global replacement */ }
try { global.process = fakeProcess; } catch { /* runtime may reject global replacement */ }
const originalGlobalThis = globalThis;
const shadowGlobalThis = Object.create(originalGlobalThis);
Object.defineProperty(shadowGlobalThis, lossKey, { value: false, writable: true, configurable: true });
try { originalGlobalThis.globalThis = shadowGlobalThis; } catch { /* runtime may reject global shadowing */ }
assert.equal(registry.ownershipLostEver(), true);
assert.throws(() => registry.beginRegisteredOperation("factory-copy-after-loss", "proof"));
const reloadedRegistry = load("operation-registry", { "./ownership-loss-latch": ownershipLatch });
assert.equal(reloadedRegistry.ownershipLostEver(), true);
assert.throws(() => reloadedRegistry.beginRegisteredOperation("reloaded-after-loss", "proof"));
const reloadedLifecycle = load("server-lifecycle", {
  "./operation-registry": registry,
  "./child-process-registry": { CHILD_PROCESS_GRACE_MS: 1, terminateRegisteredChildren: async () => ({ operationIds: [] }) },
  "./state-store": {},
  "./server-instance-lock": lock,
  "./server-ownership-events": events,
  "./ownership-loss-latch": ownershipLatch,
});
await assert.rejects(reloadedLifecycle.installServerLifecycle(), /restart required/);
assert.throws(() => registry.beginRegisteredOperation("post-loss", "proof"));
authenticProcess.send?.({ status: "pass" });
