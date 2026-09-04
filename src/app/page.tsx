"use client";

import { useRef, useState, type FormEvent } from "react";
import { agentIds, flowStepIds, rerunnableStepIds, type AgentId, type AgentResult, type AgentStatus, type FlowEvent, type FlowStep, type RerunnableStepId, type ReviewFlowResult, type ReviewRerunEvent } from "@/agents/types";
import { FlowEventParser } from "@/flows/sse";
import { acquireRunLock, releaseRunLock } from "./run-lock";

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
  const [finalOutput, setFinalOutput] = useState("");
  const [flowPrompt, setFlowPrompt] = useState("");
  const [activeRerun, setActiveRerun] = useState<RerunnableStepId | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const flowAbortRef = useRef<AbortController | null>(null);
  const currentFlowIdRef = useRef("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !acquireRunLock(sendingRef)) return;
    setSending(true);
    try { if (mode === "parallel") await runParallel(); else await runFlow(); }
    finally { releaseRunLock(sendingRef); setSending(false); }
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
    setSteps(initialSteps());
    setFinalOutput("");
    setFlowPrompt(prompt);
    const abortController = new AbortController();
    flowAbortRef.current = abortController;
    try {
      const response = await fetch("/api/flows/review/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }), signal: abortController.signal });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error("Streaming response body is unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new FlowEventParser();
      while (true) {
        const { value, done } = await reader.read();
        for (const flowEvent of parser.push(decoder.decode(value, { stream: !done }))) applyFlowEvent(flowEvent as FlowEvent);
        if (done) break;
      }
    } catch (error) {
      const aborted = abortController.signal.aborted;
      setFlowStatus(aborted ? "aborted" : "error");
      setSteps((current) => current.map((step) => step.status === "running"
        ? { ...step, status: "error", error: aborted ? "Request was aborted" : message(error) }
        : step.status === "idle" ? { ...step, status: "skipped", error: aborted ? "Request was aborted" : "Flow request failed" } : step));
    } finally {
      if (flowAbortRef.current === abortController) flowAbortRef.current = null;
    }
  }

  async function rerunStep(stepId: RerunnableStepId) {
    if (!flowPrompt || !acquireRunLock(sendingRef)) return;
    setSending(true);
    setActiveRerun(stepId);
    const abortController = new AbortController();
    flowAbortRef.current = abortController;
    try {
      const response = await fetch("/api/flows/review/rerun", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal,
        body: JSON.stringify({ prompt: flowPrompt, flowId: currentFlowIdRef.current, stepId, steps }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error("Streaming response body is unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new FlowEventParser();
      while (true) {
        const { value, done } = await reader.read();
        for (const streamEvent of parser.push(decoder.decode(value, { stream: !done }))) applyRerunEvent(streamEvent as ReviewRerunEvent);
        if (done) break;
      }
    } catch (error) {
      const aborted = abortController.signal.aborted;
      setSteps((current) => current.map((step) => step.id === stepId
        ? { ...step, status: "error", error: `Re-run failed: ${aborted ? "Request was aborted" : message(error)}` }
        : step));
    } finally {
      if (flowAbortRef.current === abortController) flowAbortRef.current = null;
      setActiveRerun(null);
      releaseRunLock(sendingRef);
      setSending(false);
    }
  }

  function applyFlowEvent(event: FlowEvent) {
    if (event.type === "flow_started") { currentFlowIdRef.current = event.flowId; setFlowStatus("running"); return; }
    if ("step" in event) {
      setSteps((current) => current.map((step) => step.id === event.step.id ? event.step : step));
      return;
    }
    setSteps(event.result.steps);
    setFinalOutput(event.result.finalOutput);
    setFlowStatus(event.result.status);
  }

  function applyRerunEvent(event: ReviewRerunEvent) {
    if (event.type === "rerun_started") return;
    if ("step" in event) {
      setSteps((current) => current.map((step) => step.id === event.step.id ? event.step : step));
      return;
    }
    setSteps(event.result.steps);
    setFinalOutput(event.result.finalOutput);
  }

  function cancelFlow() { flowAbortRef.current?.abort(new Error("Cancelled by user")); }

  return <main>
    <header><h1>MultiAgents</h1><p>Parallel answers or a fixed, reviewed response from local AI CLIs.</p></header>
    <form onSubmit={submit}>
      <fieldset className="modes" disabled={sending}><legend>Mode</legend><label><input type="radio" checked={mode === "parallel"} onChange={() => setMode("parallel")} /> Parallel</label><label><input type="radio" checked={mode === "review"} onChange={() => setMode("review")} /> Review Flow</label></fieldset>
      <label htmlFor="prompt">Prompt</label>
      <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20_000} rows={6} placeholder="Ask Codex, Cursor, and Claude…" />
      <div className="actions"><span>{prompt.length.toLocaleString()} / 20,000</span><div className="actionButtons">{sending && mode === "review" && <button className="cancel" type="button" onClick={cancelFlow}>Cancel</button>}<button type="submit" disabled={sending || !prompt.trim()}>{sending ? "Running…" : mode === "parallel" ? "Send to all" : "Run review flow"}</button></div></div>
    </form>
    {mode === "parallel" ? <section className="cards" aria-label="Agent responses">{agentIds.map((id) => <AgentCard key={id} name={labels[id]} state={cards[id]} />)}</section> : <FlowTimeline steps={steps} status={flowStatus} finalOutput={finalOutput} sending={sending} activeRerun={activeRerun} onRerun={rerunStep} />}
  </main>;
}

function AgentCard({ name, state }: { name: string; state: CardState }) { return <article className="card"><div className="cardHeader"><h2>{name}</h2><Status value={state.status} /></div>{state.error && <ErrorBlock error={state.error} />}<pre className="output">{state.output || fallback(state.status)}</pre></article>; }
function FlowTimeline({ steps, status, finalOutput, sending, activeRerun, onRerun }: { steps: FlowStep[]; status: ReviewFlowResult["status"] | "idle" | "running"; finalOutput: string; sending: boolean; activeRerun: RerunnableStepId | null; onRerun: (id: RerunnableStepId) => void }) { return <section className="flow" aria-label="Review flow"><div className="flowTitle"><h2>Review Flow</h2><Status value={status} /></div>{flowStepIds.map((id, index) => { const step = steps.find((item) => item.id === id)!; const rerunnable = rerunnableStepIds.includes(id as RerunnableStepId) && ["completed", "stale", "error"].includes(step.status) && Boolean(step.output); return <div key={id}><article className={`card flowStep ${step.role === "final" ? "finalStep" : ""}`}><div className="cardHeader"><div><span className="stepNumber">Step {index + 1}</span><h2>{labels[step.agent]} — {roleLabels[step.role]}</h2></div><Status value={step.status} /></div><div className="duration">{step.status === "running" ? activeRerun === id ? "Re-running..." : "Running..." : <>Duration: {step.durationMs === undefined ? "—" : formatDuration(step.durationMs)}</>}</div>{step.error && (step.status === "stale" ? <div className="staleReason">{step.error}</div> : <ErrorBlock error={step.error} />)}<pre className="output">{step.output || fallback(step.status)}</pre>{rerunnable && <button className="rerun" type="button" disabled={sending} onClick={() => onRerun(id as RerunnableStepId)}>Re-run</button>}</article>{index < steps.length - 1 && <div className="arrow" aria-hidden="true">↓</div>}</div>; })}{finalOutput && <article className="card finalOutput"><h2>Final Output</h2><pre className="output">{finalOutput}</pre></article>}</section>; }
function Status({ value }: { value: string }) { return <span className={`status ${value}`}>{value.toUpperCase()}</span>; }
function ErrorBlock({ error }: { error: string }) { return <div className="error"><strong>Error</strong><pre>{error}</pre></div>; }
function fallback(status: string) { return status === "idle" ? "Waiting for a prompt." : status === "running" ? "Waiting for response…" : status === "skipped" ? "This step was not run." : "No output."; }
function formatDuration(ms: number) { return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`; }
function message(error: unknown) { return error instanceof Error ? error.message : "Request failed"; }
