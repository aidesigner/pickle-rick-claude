# Pickle Rick for Claude Code

Iterative engineering lifecycle: PRD → Breakdown → Research → Plan → Implement → Refactor.

## Source of Truth — CRITICAL

Canonical → Deployed (install.sh rsyncs, overwrites deployed):
- `extension/src/*.ts` → `~/.claude/pickle-rick/extension/**/*.js`
- `.claude/commands/*.md` → `~/.claude/commands/*.md`
- `pickle_settings.json` → `~/.claude/pickle-rick/pickle_settings.json`
- `persona.md` → `~/.claude/pickle-rick/persona.md`

NEVER edit deployed files. Edit repo source, then `bash install.sh`.

## Build & Test

Run from `extension/`:
```
npx tsc --noEmit && npx tsc && npm test
```
Tests: `extension/tests/*.test.js` via `node --test`. No `.test.ts` files.

## Required Patterns

CLI guard — exact basename match, never startsWith:
```ts
if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }
```

Hook decisions — Stop hook, only "approve" or "block" (never "allow"):
```json
{ "decision": "approve" }
{ "decision": "block", "reason": "..." }
```

Error handling — never cast unknown to Error:
```ts
const msg = err instanceof Error ? err.message : String(err);
```

Extension path: always `~/.claude/pickle-rick`. Never `.gemini`.

## Architecture

dispatch.js — hook entry, reads stdin JSON, spawns handler, fail-open approve on error
stop-hook.js — checks state.json for tokens, does NOT advance lifecycle. tmux_mode: pass-through
setup.js — session init (state.json, ticket dirs), outputs first prompt
spawn-morty.js — per-ticket `claude -p` subprocess spawner
spawn-refinement-team.js — 3 parallel analysts per cycle, writes refinement_manifest.json
tmux-runner.js — context-clearing outer loop via tmux
jar-runner.js — batch runner for jar queue
metrics.js + metrics-utils.js — token/commit/LOC reporter, incremental cache at `~/.claude/pickle-rick/metrics-cache.json`
monitor.js / log-watcher.js / morty-watcher.js — tmux TUI panes
meeseeks.md — dual-purpose: setup + per-pass review template
