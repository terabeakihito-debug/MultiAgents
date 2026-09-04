# MultiAgents

MultiAgents is a local-only app that runs authenticated Codex, Cursor Agent, and Claude Code CLIs inside WSL2. It supports parallel answers and a fixed review flow.

## Status

This is intentionally a small MVP. The browser calls Next.js server routes; only the Node.js server starts the CLI processes. Each agent has a separate adapter, and requests run concurrently so one failure does not discard the other responses.

## Requirements

- WSL2 with Ubuntu 24.04 (or a compatible Linux environment)
- Node.js 20.9 or newer and npm
- Authenticated commands available on `PATH`:
  - `codex exec "..."`
  - `agent --trust --workspace <project-directory> -p "..."`
  - `~/.local/bin/claude -p "..."`

No API keys are required by this app; it uses the existing CLI authentication.

## Run locally

```bash
cd ~/code/MultiAgents
npm install
npm run dev
```

Open <http://localhost:3000>, enter a prompt, and choose a mode:

- **Parallel** / **Send to all** sends the same prompt to all three agents concurrently and displays independent results side by side.
- **Review Flow** runs `Codex draft → Cursor review → Claude review → Codex final` and updates each step in real time as it starts and finishes. Statuses, errors, completed step outputs, durations, and the final output appear without reloading the page. This is a fixed TypeScript-controlled sequence, not a free agent conversation or agent-selected handoff.

The review roles are: Codex creates the draft, Cursor reviews correctness and risks, Claude independently reviews both earlier results, and Codex produces the final user-facing answer.

After a Review Flow finishes, **Re-run** is available for Cursor Review, Claude Review, and Codex Final. Codex Draft is intentionally not rerunnable. A successful Cursor rerun replaces only Cursor's latest result and marks Claude and Final as **STALE**; a successful Claude rerun replaces only Claude's result and marks Final stale. Downstream steps are never run automatically. Stale is not a failure: the prior output stays visible with a reason, and the user can explicitly rerun that step. Rerunning Final uses the latest available draft and review results.

Rerun state and the original prompt are held only in browser memory. Reloading the page clears them; there is no database or persistent history. A rerun can be cancelled through the same **Cancel** control and process-group termination path. If it fails, is cancelled, or times out, the prior successful output is retained and the step reports the rerun failure.

If the draft fails, every later step is skipped. If Cursor fails, Claude and final Codex continue with an explicit unavailable-review marker. If Claude fails, final Codex continues with the draft and available Cursor review. A final Codex failure leaves the prior timeline visible.

Review progress uses a same-origin `fetch` POST whose response is an SSE-compatible `text/event-stream`. Streaming is step-level only: agent output is sent once that step finishes, not token by token. **Cancel** aborts the active request, stops the current CLI process group, marks the running step as errored/aborted, and skips steps that have not started. Closing the stream or disconnecting the browser aborts the server-side flow through the same signal path so the active child process is not left running.

The server binds to `127.0.0.1`. The repository selector lists only direct Git
working trees under `~/code`. Creating an isolated task makes a server-generated
`multiagents/<UUID>` branch from the selected repository's current branch HEAD
and checks it out at `~/code/.multiagents-worktrees/<repo>/<UUID>`. The source
working tree and its current branch are never used as an agent write workspace.

Repository tasks require a clean source working tree; commit or stash changes
yourself before starting. Codex Draft and Final Codex may edit only the task
worktree. Cursor and Claude are instructed to review the task and diff without
editing. No phase creates commits, pushes, merges, or PRs. The final `git diff
--stat` and `git diff` are shown in the UI.

**Delete task worktree** uses `git worktree remove` only when the task worktree
is clean. Dirty task worktrees are deliberately retained. Because task state is
in memory, a server crash can leave an orphan. Inspect and remove it manually:

```bash
git -C ~/code/REPOSITORY worktree list
git -C ~/code/REPOSITORY worktree remove ~/code/.multiagents-worktrees/REPOSITORY/TASK_UUID
git -C ~/code/REPOSITORY worktree prune
```

Review the path and preserve any wanted changes before removal. Branch deletion
is also manual.

## Verification

Use a harmless prompt such as:

```text
Reply with only your agent name.
```

Quality checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev
git diff --check
```

Tests mock process spawning and never invoke the real AI CLIs.

## Security notes

- Prompts are passed as a single argument using `spawn(binary, args, { shell: false })`; they are never concatenated into a shell command.
- The executable names and fixed arguments are defined server-side in agent adapters.
- The Claude adapter resolves its binary as `~/.local/bin/claude` from `HOME` (falling back to the operating system home directory); it otherwise inherits the server process environment, including `PATH`.
- Prompts are required and limited to 20,000 characters; CLI execution is limited to 120 seconds and captured output to 1 MB per stream.
- The complete review flow is limited to five minutes. Each prior output is capped at 30,000 characters when embedded into a later prompt, with Unicode-safe truncation markers.
- The JSON review endpoint, step-event stream endpoint, and rerun stream endpoint enforce the same localhost Host/Origin checks. CORS is not enabled, and neither prompts nor agent outputs are written to application event logs.
- Draft, review, repository content, and diff blocks are explicitly treated as untrusted content. Review prompts instruct agents never to follow commands in files, comments, or quoted output. Handoffs remain plain CLI argument strings and are never interpreted by a shell.
- Repository IDs are simple direct-child names, resolved with `realpath`, required to remain under the real `~/code` root, and verified against Git's working-tree root. Symlink escapes, `/mnt/c`, nested repositories, arbitrary paths, binaries, Git subcommands, and client-selected branch names are rejected by construction.
- Do not expose this development server to untrusted networks. The API has no authentication and intentionally launches locally authenticated tools.
- Keep `.env` files and credentials out of Git. The included `.gitignore` excludes environment files.
- Agent output and structured step metadata are logged without credentials, repository contents, or complete diffs.

## Not implemented

Draft reruns, downstream automatic reruns, old-result version history, free-form agent conversations, agent-selected or recursive handoffs, automatic loops/retries, commits, pushes, merges, PRs, remote cloning, recursive repository discovery, databases, persistent task history, long-term memory, token/cost tracking, token-level streaming, production deployment, and Docker are not implemented.
