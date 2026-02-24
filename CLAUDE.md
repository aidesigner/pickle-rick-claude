# Pickle Rick for Claude Code

Extension that transforms Claude Code into "Pickle Rick" — enforces an iterative engineering lifecycle: **PRD → Breakdown → Research → Plan → Implement → Refactor**.

## Commands

- **`/pickle <task>`**: Start the autonomous loop
- **`/pickle-tmux <task>`**: Context-clearing mode via tmux (for long epics, 8+ iterations)
- **`/pickle-prd [task]`**: Interactively draft a PRD, then `/pickle --resume`
- **`/pickle-refine-prd [path]`**: Refine PRD + decompose into discrete tasks with pre-created tickets; resume directly into orchestration
- **`/eat-pickle`**: Cancel the active loop
- **`/pickle-status`**: Show session phase, iteration, ticket status
- **`/pickle-retry <ticket-id>`**: Re-spawn a Morty for a failed ticket
- **`/add-to-pickle-jar`** / **`/pickle-jar-open`**: Queue tasks / run queued batch
- **`/disable-pickle`** / **`/enable-pickle`**: Toggle stop hook

## Engineering Rules

### Source of Truth

**TypeScript sources in `extension/src/` are canonical.** JS files in `extension/` are build artifacts — never edit them directly. The `src/` directory mirrors the output structure: `src/bin/*.ts` → `bin/*.js`, etc.

### Build & Test

All commands run from `extension/`:

```bash
npx tsc --noEmit   # Type-check (run first)
npx tsc            # Compile
npm test           # Run full suite — all tests must pass before committing
```

Tests live in `extension/tests/*.test.js` (run via `node --test`). No `.test.ts` files in `src/`.

### Critical Patterns

**CLI Guard** — Use exact filename matching, never `startsWith` (prevents `foo.test.js` from triggering `foo.js`'s CLI block):
```typescript
if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }
```

**Hook Decisions** — This is a `Stop` hook. Only `"approve"` or `"block"` (never `"allow"`):
```json
{ "decision": "approve" }
{ "decision": "block", "reason": "..." }
```

**Error Handling** — Never cast `err` to `Error` blindly:
```typescript
const msg = err instanceof Error ? err.message : String(err);
```

**Extension Path** — Always `~/.claude/pickle-rick`. If you see `.gemini` anywhere, it's wrong.

### Architecture

- **`dispatch.js`** — Stop hook entry point. Reads stdin JSON, spawns matching handler, forwards stdout. Fail-open: always outputs `"approve"` on error.
- **`stop-hook.js`** — Gatekeeper. Checks `state.json` for completion/checkpoint tokens. Does NOT advance lifecycle or spawn workers. In `tmux_mode`, checkpoint tokens pass through for tmux-runner to handle.
- **`setup.js`** — Initializes session (`state.json`, ticket dirs), outputs first prompt.
- **`spawn-morty.js`** — Worker spawner for per-ticket `claude -p` subprocesses.
- **`spawn-refinement-team.js`** — PRD refinement orchestrator. Spawns 3 parallel analysts per cycle, supports `--cycles N` and `--max-turns N`. Writes `refinement_manifest.json`.
- **`tmux-runner.js`** — Context-clearing loop via tmux panes.
- **`jar-runner.js`** — Batch runner for queued jar tasks.
- **`monitor.js`** / **`log-watcher.js`** — Live TUI dashboard / streaming log tail.
