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
- **Review Flow** runs `Codex draft → Cursor review → Claude review → Codex final`, then displays all four steps, statuses, errors, outputs, and durations as one timeline. This is a fixed TypeScript-controlled sequence, not a free agent conversation or agent-selected handoff.

The review roles are: Codex creates the draft, Cursor reviews correctness and risks, Claude independently reviews both earlier results, and Codex produces the final user-facing answer.

If the draft fails, every later step is skipped. If Cursor fails, Claude and final Codex continue with an explicit unavailable-review marker. If Claude fails, final Codex continues with the draft and available Cursor review. A final Codex failure leaves the prior timeline visible.

The server binds to `127.0.0.1`. Agent processes use the project directory as
their explicit working directory. The workspace value is centralized in the
server-side adapters for future extension; there is intentionally no repository
selector in this MVP.

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
- Draft and review blocks are explicitly delimited as untrusted content. Review prompts instruct agents never to follow commands inside quoted agent output. Handoffs remain plain CLI argument strings and are never interpreted by a shell.
- Do not expose this development server to untrusted networks. The API has no authentication and intentionally launches locally authenticated tools.
- Keep `.env` files and credentials out of Git. The included `.gitignore` excludes environment files.
- The server uses its current WSL working directory. It does not search Windows mounts.

## Not implemented

Free-form agent conversations, agent-selected or recursive handoffs, automatic loops/retries, automated code edits, repository selection, worktrees, GitHub automation, databases, long-term memory, token/cost tracking, streaming output, production deployment, and Docker are not implemented.
