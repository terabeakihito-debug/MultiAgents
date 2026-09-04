"use client";

import { useRef, useState, type FormEvent } from "react";
import { agentIds, type AgentId, type AgentResult, type AgentStatus } from "@/agents/types";

const labels: Record<AgentId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  claude: "Claude",
};

type CardState = { status: AgentStatus; output: string; error?: string };

const initialCards = (): Record<AgentId, CardState> => ({
  codex: { status: "idle", output: "" },
  cursor: { status: "idle", output: "" },
  claude: { status: "idle", output: "" },
});

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [cards, setCards] = useState(initialCards);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setCards(Object.fromEntries(agentIds.map((id) => [id, { status: "running", output: "" }])) as Record<AgentId, CardState>);

    await Promise.allSettled(agentIds.map(async (id) => {
      try {
        const response = await fetch(`/api/agents/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await response.json() as AgentResult | { error: string };
        if (!response.ok || !("agent" in data)) {
          throw new Error(data.error || `Request failed (${response.status})`);
        }
        setCards((current) => ({ ...current, [id]: { status: data.status, output: data.output, error: data.error } }));
      } catch (error) {
        setCards((current) => ({
          ...current,
          [id]: { status: "error", output: "", error: error instanceof Error ? error.message : "Request failed" },
        }));
      }
    }));
    sendingRef.current = false;
    setSending(false);
  }

  return (
    <main>
      <header><h1>MultiAgents</h1><p>One prompt, three local AI CLIs.</p></header>
      <form onSubmit={submit}>
        <label htmlFor="prompt">Prompt</label>
        <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20_000} rows={6} placeholder="Ask Codex, Cursor, and Claude…" />
        <div className="actions"><span>{prompt.length.toLocaleString()} / 20,000</span><button type="submit" disabled={sending || !prompt.trim()}>{sending ? "Running…" : "Send to all"}</button></div>
      </form>
      <section className="cards" aria-label="Agent responses">
        {agentIds.map((id) => <AgentCard key={id} name={labels[id]} state={cards[id]} />)}
      </section>
    </main>
  );
}

function AgentCard({ name, state }: { name: string; state: CardState }) {
  return (
    <article className="card">
      <div className="cardHeader"><h2>{name}</h2><span className={`status ${state.status}`}>{state.status.toUpperCase()}</span></div>
      {state.error && <div className="error"><strong>Error</strong><pre>{state.error}</pre></div>}
      <pre className="output">{state.output || (state.status === "idle" ? "Waiting for a prompt." : state.status === "running" ? "Waiting for response…" : "No output.")}</pre>
    </article>
  );
}
