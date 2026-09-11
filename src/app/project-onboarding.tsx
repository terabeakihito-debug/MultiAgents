"use client";

import { useState, type FormEvent } from "react";
import { humanMutationFetch } from "./human-mutation";

export type AddedProject = { id: string; name: string };
type Choice = "menu" | "github" | "local" | "create" | "ready";

export function ProjectOnboarding({ disabled, onAdded, onError, initializationRequiredProject, initializationRepairRequired = false }: { disabled: boolean; onAdded: (project: AddedProject, needsInitialCommit: boolean) => void; onError: (error: string) => void; initializationRequiredProject?: AddedProject; initializationRepairRequired?: boolean }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>("menu");
  const [githubUrl, setGithubUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [createReadme, setCreateReadme] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdProject, setCreatedProject] = useState<AddedProject | null>(null);

  function close() { if (!busy) { setOpen(false); setChoice("menu"); setStatus(""); setError(""); } }
  function reopenInitialization() { if (initializationRequiredProject) { setCreatedProject(initializationRequiredProject); setChoice("ready"); setError(""); setOpen(true); } }
  async function submit(event: FormEvent, endpoint: "/api/repos/clone" | "/api/repos/create", action: "repository-clone" | "repository-create") {
    event.preventDefault(); setError(""); setBusy(true); setStatus(endpoint.endsWith("clone") ? "Validating GitHub project…" : "Creating project…");
    try {
      setStatus(endpoint.endsWith("clone") ? "Cloning…" : "Preparing project…");
      const response = await humanMutationFetch(endpoint, action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(endpoint.endsWith("clone") ? { githubUrl } : { projectName, createReadme }) });
      const data = await response.json() as { repo?: AddedProject; needsInitialCommit?: boolean; error?: string };
      if (!response.ok || !data.repo) throw new Error(data.error || "Project setup failed");
      setStatus("Ready"); onAdded(data.repo, data.needsInitialCommit === true);
      if (data.needsInitialCommit === true) { setCreatedProject(data.repo); setChoice("ready"); } else { setOpen(false); setChoice("menu"); }
    } catch (error) { const message = error instanceof Error ? error.message : "Project setup failed"; setStatus(""); setError(message); onError(message); }
    finally { setBusy(false); }
  }
  async function initialize() {
    if (!createdProject) return; setError(""); setBusy(true); setStatus("Initializing project…");
    try { const response = await humanMutationFetch(`/api/repos/${encodeURIComponent(createdProject.id)}/initialize`, "repository-initialize", { method: "POST" }); const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Project initialization failed"); onAdded(createdProject, false); setOpen(false); setChoice("menu"); setCreatedProject(null); }
    catch (error) { const message = error instanceof Error ? error.message : "Project initialization failed"; if (message.startsWith("Initial commit was created")) onAdded(createdProject, false); setError(message); onError(message); }
    finally { setBusy(false); setStatus(""); }
  }
  return <>{initializationRequiredProject ? <div className="initializationNotice" role="status"><strong>{initializationRepairRequired ? "Complete project setup to start tasks" : "Initialize project to start tasks"}</strong><span>{initializationRepairRequired ? "The initial commit exists, but project setup needs completion." : "This local project has no initial commit yet."}</span><button type="button" className="secondary" disabled={disabled} onClick={reopenInitialization}>{initializationRepairRequired ? "Complete setup" : "Initialize project"}</button></div> : null}<button type="button" className="secondary addProjectButton" disabled={disabled} onClick={() => { setError(""); setOpen(true); }}>+ Add project</button>
    {open ? <div className="dialogBackdrop" role="presentation"><section className="projectOnboarding" role="dialog" aria-modal="true" aria-labelledby="add-project-title"><div className="projectDialogHeader"><div><span className="eyebrow">Projects</span><h2 id="add-project-title">Add project</h2></div><button type="button" className="secondary" disabled={busy} onClick={close}>Close</button></div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {choice === "menu" ? <div className="projectChoices"><button type="button" onClick={() => setChoice("github")}><strong>Add from GitHub</strong><small>Paste a GitHub repository URL and MultiAgents will prepare it locally.</small></button><button type="button" onClick={() => setChoice("local")}><strong>Use an existing local project</strong><small>Projects already in the managed projects folder are detected automatically.</small></button><button type="button" onClick={() => setChoice("create")}><strong>Create a new project</strong><small>Start a new local project. GitHub can be connected later.</small></button></div> : null}
      {choice === "github" ? <form onSubmit={(event) => void submit(event, "/api/repos/clone", "repository-clone")}><p className="muted">Only standard GitHub HTTPS or SSH repository URLs are accepted.</p><label>GitHub repository URL<input autoFocus value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repository" required disabled={busy} /></label><div className="dialogActions"><button type="button" className="secondary" disabled={busy} onClick={() => setChoice("menu")}>Back</button><button type="submit" disabled={busy || !githubUrl.trim()}>{busy ? status || "Working…" : "Add from GitHub"}</button></div></form> : null}
      {choice === "local" ? <div><p>Projects in the managed projects folder are detected automatically. Put an existing Git project directly in <code>~/code</code>, then return here or refresh the Tasks page.</p><p className="muted">Choosing a local path in this app is intentionally not supported.</p><div className="dialogActions"><button type="button" onClick={() => setChoice("menu")}>Back</button></div></div> : null}
      {choice === "create" ? <form onSubmit={(event) => void submit(event, "/api/repos/create", "repository-create")}><p>MultiAgents uses Git internally to safely track changes. You do not need to manage Git manually.</p><label>Project name<input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="MyApp" required disabled={busy} /></label><label className="checkboxLabel"><input type="checkbox" checked={createReadme} onChange={(event) => setCreateReadme(event.target.checked)} disabled={busy} /> Add a starter README</label><p className="muted">GitHub: not connected. You can connect it later. No initial commit is made automatically.</p><div className="dialogActions"><button type="button" className="secondary" disabled={busy} onClick={() => setChoice("menu")}>Back</button><button type="submit" disabled={busy || !projectName.trim()}>{busy ? status || "Working…" : "Create project"}</button></div></form> : null}
      {choice === "ready" && createdProject ? <div><h3>{initializationRepairRequired ? "Complete project setup" : "Project created"}</h3><p>{initializationRepairRequired ? "The initial commit was created successfully. Complete setup to synchronize the approved README; retrying will not create another commit." : "MultiAgents uses Git internally to safely track changes. Make the initial setup commit to start tasks; this commit contains only the optional starter README."}</p><p className="muted">GitHub: not connected. You can connect it later.</p><div className="dialogActions"><button type="button" className="secondary" disabled={busy} onClick={close}>Do this later</button><button type="button" disabled={busy} onClick={() => void initialize()}>{busy ? status || "Working…" : initializationRepairRequired ? "Complete setup" : "Initialize project"}</button></div></div> : null}
    </section></div> : null}</>;
}
