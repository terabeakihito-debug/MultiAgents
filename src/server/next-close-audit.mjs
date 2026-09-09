/**
 * NextCustomServer.close() intentionally settles its internal cleanup work.
 * Track the callbacks MultiAgents registers with the public onServerClose API
 * so a rejected callback remains visible to the launcher.
 */
export function installNextCloseAudit(app) {
  const callbacks = new Map();
  const onServerClose = findOnServerClose(app.server);
  if (typeof onServerClose !== "function") return { register: () => { throw new Error("next_close_audit_unavailable"); }, assertSucceeded: () => { throw new Error("next_close_audit_unavailable"); }, snapshot: () => [] };
  return {
    register(name, cleanup, { required = true } = {}) {
      if (callbacks.has(name)) throw new Error("next_close_audit_duplicate_callback");
      const state = { name, required, registered: true, started: false, completed: false, failed: false };
      callbacks.set(name, state);
      onServerClose.call(app.server, async () => {
        state.started = true;
        try { await cleanup(); state.completed = true; }
        catch (error) { state.failed = true; throw error; }
      });
    },
    assertSucceeded() {
      for (const state of callbacks.values()) {
        if (state.required && state.failed) throw new Error("next_framework_cleanup_failed");
        if (state.required && (!state.started || !state.completed)) throw new Error("next_framework_cleanup_incomplete");
      }
    },
    snapshot: () => [...callbacks.values()].map((state) => ({ ...state })),
  };
}

function findOnServerClose(server) {
  let current = server;
  for (let depth = 0; current && depth < 3; depth++, current = current.server) {
    if (typeof current.onServerClose === "function") return current.onServerClose.bind(current);
  }
  return undefined;
}
