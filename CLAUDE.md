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

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **pickle-rick-claude** (341 symbols, 689 relationships, 12 execution flows).

## Always Start Here

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
