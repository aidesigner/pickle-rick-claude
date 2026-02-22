# Pickle Rick for Claude Code

This directory contains the **Pickle Rick** extension for Claude Code CLI.

## Project Overview

The extension transforms Claude Code into "Pickle Rick" (from Rick and Morty) — a hyper-intelligent, arrogant, but extremely competent coding agent. It enforces a rigid, iterative engineering lifecycle: **PRD → Breakdown → Research → Plan → Implement → Refactor**.

## Key Components

- **`.claude/commands/`**: Slash commands (`/pickle`, `/pickle-tmux`, `/pickle-prd`, `/eat-pickle`, `/help-pickle`, `/pickle-status`, `/pickle-retry`, `/add-to-pickle-jar`, `/pickle-jar-open`, `/disable-pickle`, `/enable-pickle`)
- **`extension/bin/`**: Runtime scripts (setup, cancel, spawn-morty, worker-setup, update-state, get-session, jar-runner, tmux-runner, monitor, status, retry-ticket)
- **`extension/hooks/`**: Stop hook dispatcher and handlers
- **`extension/services/`**: Shared utilities (pickle-utils, git-utils, pr-factory, jar-utils)
- **`pickle_settings.json`**: Default limits and settings
- **`persona.md`**: Persona snippet — append to your project's `CLAUDE.md`
- **`install.sh`** / **`uninstall.sh`**: Deployment scripts

## Commands

- **`/pickle <task>`**: Start the autonomous loop (PRD → Breakdown → per-ticket Research/Plan/Implement/Refactor)
- **`/pickle-tmux <task>`**: True context clearing mode — spawns a fresh `claude -p` per iteration in a tmux session. Use for long epics (8+ iterations).
- **`/pickle-prd [task]`**: Interactively draft a PRD, then resume with `/pickle --resume`
- **`/eat-pickle`**: Cancel the active loop
- **`/help-pickle`**: Show help
- **`/pickle-status`**: Show current session phase, iteration, and ticket status
- **`/pickle-retry <ticket-id>`**: Reset a failed ticket to Todo and re-spawn a Morty for it
- **`/add-to-pickle-jar`**: Save the current session's PRD to a queue for later batch execution
- **`/pickle-jar-open`**: Run all queued Jar tasks sequentially (Night Shift / Grand Overseer Mode)
- **`/disable-pickle`**: Disable the stop hook globally without uninstalling
- **`/enable-pickle`**: Re-enable the stop hook

---

## Engineering Rules

### Source of Truth

**TypeScript sources in `extension/src/` are canonical.** Compiled `.js` files in `extension/` are build artifacts — never edit them directly.

- Always edit `.ts` source files, then recompile.
- If a compiled `.js` diverges from its `.ts` source (e.g. it was hand-edited), the more complete and correct version wins — update the `.ts` to match, then recompile.
- The `extension/src/` directory mirrors the output structure. `src/bin/*.ts` → `bin/*.js`, `src/services/*.ts` → `services/*.js`, `src/hooks/**/*.ts` → `hooks/**/*.js`.

### Build & Test Commands

All commands run from `extension/`:

```bash
# Type-check without emitting (fast validation)
npx tsc --noEmit

# Compile TS → JS
npx tsc

# Run full test suite
npm test
```

**Always run `tsc --noEmit` before `tsc`.** Always run `npm test` after compiling. All 66 tests must pass before committing.

### Valid Source File Manifest

These are the canonical `.ts` files. Any `.js` outside this list that has no corresponding `.ts` source is a stale artifact and should be deleted.

**`src/bin/`**
- `cancel.ts` + `cancel.test.ts`
- `get-session.ts` + `get-session.test.ts`
- `jar-runner.ts` *(no test — tested via integration)*
- `retry-ticket.ts` *(tests in `tests/retry-ticket.test.js`)*
- `setup.ts` *(tests in `tests/setup.test.js`)*
- `spawn-morty.ts`
- `status.ts`
- `tmux-runner.ts`
- `update-state.ts` + `update-state.test.ts`
- `worker-setup.ts`

**`src/hooks/`**
- `dispatch.ts`
- `resolve-state.ts`
- `handlers/stop-hook.ts`

**`src/services/`**
- `git-utils.ts` + `git-utils.test.ts`
- `jar-utils.ts` + `jar-utils.test.ts`
- `pickle-utils.ts` + `pickle-utils.test.ts`
- `pr-factory.ts` + `pr-factory.test.ts`

**`src/types/`**
- `index.ts`

**Deleted / Dead (do not restore):**
- `src/bin/spawn-rick.ts` — deleted; no command invokes it
- Any `src/` file importing `spawn_cmd` or `printBanner` — those functions don't exist in pickle-utils

### CLI Guard Pattern

Every script that doubles as an importable module **must** use exact filename matching for its CLI guard, not `startsWith`:

```typescript
// CORRECT — exact match prevents triggering on foo.test.js imports
if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }

// WRONG — 'foo.test.js'.startsWith('foo') is true, executes CLI block during tests
if (process.argv[1] && path.basename(process.argv[1]).startsWith('foo')) { ... }
```

This applies to: `update-state.ts`, `get-session.ts`, `jar-utils.ts`, and any future modules with CLI blocks.

### Extension Directory Path

The extension installs to `~/.claude/pickle-rick`. This path appears in several places:

```typescript
// CORRECT
const EXTENSION_DIR = join(os.homedir(), '.claude/pickle-rick');

// WRONG — stale path from a different tool, causes silent failures
const EXTENSION_DIR = join(os.homedir(), '.gemini/extensions/pickle-rick');
```

If you see `.gemini` anywhere in this codebase, it is wrong. Fix it immediately.

### wrapText Word-Wrap Logic

The `wrapText` function in `pickle-utils.ts` must account for the space separator when checking line length:

```typescript
// CORRECT — measures actual joined length including space
if ((currentLine === '' ? word : currentLine + ' ' + word).length <= width) {

// WRONG — misses the space, produces lines 1 char over the limit
if ((currentLine + word).length <= width) {
```

### Key Architectural Notes

- **`dispatch.js`** is the Claude Code stop hook entry point. It reads stdin (JSON from Claude Code), finds the matching handler in `hooks/handlers/`, spawns it as a child process, and forwards its stdout. Always outputs `{ "decision": "allow" }` on any failure — never blocks Claude Code.
- **`stop-hook.js`** is the main handler. It reads `state.json`, checks for completion promises in Claude's response text, advances the lifecycle (PRD → Breakdown → Research → Plan → Implement → Refactor), and spawns the next worker via `spawn-morty.js`.
- **`tmux-runner.js`** is the true context-clearing loop — spawns `claude -p` in a tmux pane per iteration. Use for epics (8+ tickets).
- **`jar-runner.js`** is the night-shift batch runner — iterates marinating jar tasks and runs each via `claude --dangerously-skip-permissions`.
- **`setup.js`** initializes a new session (`state.json`, ticket directories) and outputs the first prompt.
- **`spawn-morty.js`** is the worker spawner — invoked by the stop hook to start a fresh `claude -p` subprocess for each ticket.

