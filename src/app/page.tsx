"use client";

import { useRef, useState, type FormEvent } from "react";
import { agentIds, flowStepIds, type AgentId, type AgentResult, type AgentStatus, type FlowStep, type ReviewFlowResult } from "@/agents/types";

const labels: Record<AgentId, string> = { codex: "Codex", cursor: "Cursor", claude: "Claude" };
const roleLabels = { draft: "Draft", review: "Review", final: "Final" } as const;
type Mode = "parallel" | "review";
type CardState = { status: AgentStatus; output: string; error?: string };
const initialCards = (): Record<AgentId, CardState> => ({ codex: { status: "idle", output: "" }, cursor: { status: "idle", output: "" }, claude: { status: "idle", output: "" } });
const initialSteps = (): FlowStep[] => [
  { id: "codex_draft", agent: "codex", role: "draft", status: "idle", output: "" },
  { id: "cursor_review", agent: "cursor", role: "review", status: "idle", output: "" },
  { id: "claude_review", agent: "claude", role: "review", status: "idle", output: "" },
  { id: "codex_final", agent: "codex", role: "final", status: "idle", output: "" },
];

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("parallel");
  const [cards, setCards] = useState(initialCards);
  const [steps, setSteps] = useState(initialSteps);
  const [flowStatus, setFlowStatus] = useState<ReviewFlowResult["status"] | "idle" | "running">("idle");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try { if (mode === "parallel") await runParallel(); else await runFlow(); }
    finally { sendingRef.current = false; setSending(false); }
  }

  async function runParallel() {
    setCards(Object.fromEntries(agentIds.map((id) => [id, { status: "running", output: "" }])) as Record<AgentId, CardState>);
    await Promise.allSettled(agentIds.map(async (id) => {
      try {
        const response = await fetch(`/api/agents/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
        const data = await response.json() as AgentResult | { error: string };
        if (!response.ok || !("agent" in data)) throw new Error(data.error || `Request failed (${response.status})`);
        setCards((current) => ({ ...current, [id]: { status: data.status, output: data.output, error: data.error } }));
      } catch (error) { setCards((current) => ({ ...current, [id]: { status: "error", output: "", error: message(error) } })); }
    }));
  }

  async function runFlow() {
    setFlowStatus("running");
    setSteps(initialSteps().map((step, index) => ({ ...step, status: index === 0 ? "running" : "idle" })));
    try {
      const response = await fetch("/api/flows/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
      const data = await response.json() as ReviewFlowResult | { error: string };
      if (!response.ok || !("steps" in data)) throw new Error(("error" in data && data.error) || `Request failed (${response.status})`);
      setSteps(data.steps); setFlowStatus(data.status);
    } catch (error) {
      setFlowStatus("error");
      setSteps((current) => current.map((step, index) => index === 0 ? { ...step, status: "error", error: message(error) } : { ...step, status: "skipped", error: "Flow request failed" }));
    }
  }

  return <main>
    <header><h1>MultiAgents</h1><p>Parallel answers or a fixed, reviewed response from local AI CLIs.</p></header>
    <form onSubmit={submit}>
      <fieldset className="modes" disabled={sending}><legend>Mode</legend><label><input type="radio" checked={mode === "parallel"} onChange={() => setMode("parallel")} /> Parallel</label><label><input type="radio" checked={mode === "review"} onChange={() => setMode("review")} /> Review Flow</label></fieldset>
      <label htmlFor="prompt">Prompt</label>
      <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20_000} rows={6} placeholder="Ask Codex, Cursor, and Claude…" />
      <div className="actions"><span>{prompt.length.toLocaleString()} / 20,000</span><button type="submit" disabled={sending || !prompt.trim()}>{sending ? "Running…" : mode === "parallel" ? "Send to all" : "Run review flow"}</button></div>
    </form>
    {mode === "parallel" ? <section className="cards" aria-label="Agent responses">{agentIds.map((id) => <AgentCard key={id} name={labels[id]} state={cards[id]} />)}</section> : <FlowTimeline steps={steps} status={flowStatus} />}
  </main>;
}

function AgentCard({ name, state }: { name: string; state: CardState }) { return <article className="card"><div className="cardHeader"><h2>{name}</h2><Status value={state.status} /></div>{state.error && <ErrorBlock error={state.error} />}<pre className="output">{state.output || fallback(state.status)}</pre></article>; }
function FlowTimeline({ steps, status }: { steps: FlowStep[]; status: ReviewFlowResult["status"] | "idle" | "running" }) { return <section className="flow" aria-label="Review flow"><div className="flowTitle"><h2>Review Flow</h2><Status value={status} /></div>{flowStepIds.map((id, index) => { const step = steps.find((item) => item.id === id)!; return <div key={id}><article className={`card flowStep ${step.role === "final" ? "finalStep" : ""}`}><div className="cardHeader"><div><span className="stepNumber">Step {index + 1}</span><h2>{labels[step.agent]} — {roleLabels[step.role]}</h2></div><Status value={step.status} /></div><div className="duration">Duration: {step.durationMs === undefined ? "—" : formatDuration(step.durationMs)}</div>{step.error && <ErrorBlock error={step.error} />}<pre className="output">{step.output || fallback(step.status)}</pre></article>{index < steps.length - 1 && <div className="arrow" aria-hidden="true">↓</div>}</div>; })}</section>; }
function Status({ value }: { value: string }) { return <span className={`status ${value}`}>{value.toUpperCase()}</span>; }
function ErrorBlock({ error }: { error: string }) { return <div className="error"><strong>Error</strong><pre>{error}</pre></div>; }
function fallback(status: string) { return status === "idle" ? "Waiting for a prompt." : status === "running" ? "Waiting for response…" : status === "skipped" ? "This step was not run." : "No output."; }
function formatDuration(ms: number) { return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`; }
function message(error: unknown) { return error instanceof Error ? error.message : "Request failed"; }
