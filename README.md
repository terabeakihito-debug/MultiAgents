# MultiAgents

MultiAgents is a local-only MVP that sends one browser prompt to three authenticated AI CLIs running inside WSL2—Codex, Cursor Agent, and Claude Code—and displays their results side by side.

## Status

This is intentionally a small MVP. The browser calls Next.js server routes; only the Node.js server starts the CLI processes. Each agent has a separate adapter, and requests run concurrently so one failure does not discard the other responses.

## Requirements

- WSL2 with Ubuntu 24.04 (or a compatible Linux environment)
- Node.js 20.9 or newer and npm
- Authenticated commands available on `PATH`:
  - `codex exec "..."`
  - `cursor-agent --trust -p "..."`
  - `~/.local/bin/claude -p "..."`

No API keys are required by this app; it uses the existing CLI authentication.

## Run locally

```bash
cd ~/code/MultiAgents
npm install
npm run dev
```

Open <http://localhost:3000>, enter a prompt, and select **Send to all**.

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
```

Tests mock process spawning and never invoke the real AI CLIs.

## Security notes

- Prompts are passed as a single argument using `spawn(binary, args, { shell: false })`; they are never concatenated into a shell command.
- The executable names and fixed arguments are defined server-side in agent adapters.
- The Claude adapter resolves its binary as `~/.local/bin/claude` from `HOME` (falling back to the operating system home directory); it otherwise inherits the server process environment, including `PATH`.
- Prompts are required and limited to 20,000 characters; CLI execution is limited to 120 seconds and captured output to 1 MB per stream.
- Do not expose this development server to untrusted networks. The API has no authentication and intentionally launches locally authenticated tools.
- Keep `.env` files and credentials out of Git. The included `.gitignore` excludes environment files.
- The server uses its current WSL working directory. It does not search Windows mounts.

## Not implemented

Agent-to-agent conversations, handoffs, automated review or edits, repository selection, worktrees, GitHub automation, databases, long-term memory, token/cost tracking, personas, permission orchestration, streaming output, production deployment, and Docker are outside this MVP.
