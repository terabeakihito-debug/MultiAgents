let activeAgentExecutions = 0;

export function beginAgentExecution() {
  activeAgentExecutions += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeAgentExecutions = Math.max(0, activeAgentExecutions - 1);
  };
}

export function isAgentExecutionActive() {
  return activeAgentExecutions > 0;
}
