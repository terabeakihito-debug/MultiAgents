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
  - `gh auth status --hostname github.com`

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
editing. The final tracked and untracked changes are shown in the UI.

Pull requests require explicit human approval. After the fixed Review Flow
finishes, the server creates a SHA-256 hash from a canonical snapshot of every
changed tracked and untracked file. The approval checkbox and
**Approve & Create PR** button apply only to that one snapshot. The server
rejects a reused approval or any worktree change and requires the latest diff to
be reviewed again.

After approval, the server repeats repository, worktree, branch, conflict, Git
metadata, and diff-hash checks. It scans changed files for prohibited credential
filenames and common secret patterns. If `package.json` exists, it runs only
the defined `test`, `lint`, `typecheck`, and `build` npm scripts, in that
order, with a timeout for each command. Before running those scripts it requires
a real, task-local `node_modules` directory and verifies the installed tree with
`npm ls --all --include=dev --ignore-scripts --offline`. Phase 5 never runs `npm install`:
missing or incomplete dependencies stop validation with `dependencies not
installed in task worktree`. A symlink to the source repository's
`node_modules` is rejected so task isolation is preserved. Install dependencies
explicitly in the task worktree, then retry approval. A failed check stops
before commit.

Only after every check passes does the server stage all worktree changes,
recheck the approved hash, create a server-named commit, push the
`multiagents/<UUID>` branch to a validated GitHub `origin`, and create a pull
request with the existing `gh` login. It never stores a GitHub token. Phase 5
does not merge, approve, deploy, force-push, delete the branch, or push the base
branch. The task worktree remains available after PR creation.

## PR review intake and rework

For an existing task PR, **Fetch review** runs the fixed Phase 6 intake:
`Codex triage → Cursor validation → Claude independent validation → Codex
rework plan`. It retrieves PR metadata, changed files, reviews, line comments,
review threads, and checks with fixed server-side `gh pr view`, `gh pr diff`,
`gh pr checks`, and `gh api` argument arrays. The selected repository's
validated GitHub origin, PR URL/number, base, task branch, local worktree HEAD,
and PR head SHA must all agree. Closed or merged PRs are rejected.

GitHub review text is untrusted external content. It is placed in marked,
bounded prompt blocks and is never used as a command, branch, path, approval,
or Git/GitHub argument. `CHANGES_REQUESTED`, unresolved threads, and failed
required checks are promoted by deterministic server rules to at least action
required; LLM output cannot downgrade those signals. Intake is read-only:
Codex uses its read-only sandbox, and the server fingerprints the worktree
around every Codex, Cursor, and Claude intake/review step.

The server does not begin edits after intake. A human must press **Apply
reviewed fixes**. Only then may Codex edit the retained task worktree. Cursor
and Claude review the changes without write authority, and final Codex may make
minimal corrections. The revised tracked/untracked diff receives a new hash,
new approval ID, and a required **I reviewed the revised final diff** checkbox.
The Phase 5 approval is never reused.

After the second approval, the server repeats the diff-hash check, secret scan,
dependency check, and defined `test`, `lint`, `typecheck`, and `build` scripts.
It appends a new `multiagents: address PR review` commit and performs only
`git push origin multiagents/<UUID>`. It never amends, rebases, or force-pushes.
No second PR is created: the server confirms that the same PR number now has
the new head SHA, then polls required CI checks for at most five minutes.
Unresolved threads may be displayed as **Potentially addressed**, but are never
resolved automatically.

`READY_FOR_HUMAN_MERGE` is display-only. MultiAgents provides a link to GitHub
and has no merge or auto-merge button. It never submits a GitHub approval,
deletes a branch, deploys, closes an issue, or pushes/merges directly to the
base branch. The final merge is always performed by a human outside this app.

**Delete task worktree** uses `git worktree remove` only before a task has
created a commit and only when the task worktree is clean. Dirty, committed, and
pushed task worktrees are deliberately retained for explicit manual cleanup.
Task, intake, and approval state live only in the server process. After a
restart, **Find open PRs** lists only open PRs from the selected repository's
validated GitHub origin. Recovery is allowed only when an already registered
server-managed worktree, `multiagents/<UUID>` branch, clean local HEAD, PR head
SHA, base, and origin all match. Recovery never creates a replacement
worktree. If the worktree is missing, MultiAgents creates only an in-memory,
read-only intake session against the selected repository and PR; it does not
restore write capability. Because the original task prompt cannot be
authenticated after a restart, every recovered session may fetch/display
review data but automatic rework is disabled. A present but ambiguous or
mismatched worktree stops recovery. Inspect or remove an orphan manually:

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
- Approval, commit, push, and PR creation are controlled only by the server-side task state machine. Repository text and agent output cannot select a Git command or bypass approval. A task-scoped server lock prevents duplicate commits and PRs.
- The approval hash covers the final file content, file mode, symlink target, deletion state, and base commit for both tracked and untracked changes. Content that exceeds the review limits or cannot be fully shown is not approvable.
- Secret filename rules and content rules are separate. `.env`, `.env.*`, private-key files, credential files, token-named files, private-key headers, and common provider key formats stop the operation without an override.
- Git and GitHub commands use fixed binaries, fixed server-built argument arrays, a worktree-only current directory, and `shell: false`. Only standard `https://github.com/owner/repo.git` and `git@github.com:owner/repo.git` origins are accepted.
- PR selection accepts only a server-side validated repository ID and numeric PR number. Arbitrary PR URLs, repositories, `gh` commands, Git commands, branch names, and shell input are not accepted from the browser.
- PR/review logs contain only bounded metadata such as repository, PR number, short head SHA, check/review counts, and unresolved count. Full review bodies, repository content, credentials, authorization headers, and environment variables are not logged.
- Dependency checks and npm validation use only fixed server-selected arguments with `shell: false`. Phase 5 performs no automatic package installation or lifecycle-script execution outside the explicitly allowlisted validation scripts.
- Do not expose this development server to untrusted networks. The API has no authentication and intentionally launches locally authenticated tools.
- Keep `.env` files and credentials out of Git. The included `.gitignore` excludes environment files.
- Agent output and structured step metadata are logged without credentials, repository contents, or complete diffs.

## Not implemented

Draft reruns, downstream automatic reruns, old-result version history, free-form
agent conversations, agent-selected or recursive handoffs, automatic retry
loops, merges, remote cloning, recursive repository
discovery, databases, persistent task history, long-term memory, token/cost
tracking, token-level streaming, production deployment, and Docker are not
implemented.
