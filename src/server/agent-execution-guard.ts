const shared = globalThis as typeof globalThis & { __multiAgentsActiveExecutions?: number };
shared.__multiAgentsActiveExecutions ??= 0;

export function beginAgentExecution() {
  shared.__multiAgentsActiveExecutions! += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    shared.__multiAgentsActiveExecutions = Math.max(0, shared.__multiAgentsActiveExecutions! - 1);
  };
}

export function isAgentExecutionActive() {
  return shared.__multiAgentsActiveExecutions! > 0;
}
