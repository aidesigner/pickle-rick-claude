# ⛔ STOP — Worker Forbidden Ops (R-WSRC)

You're a worker inside pickle-rick-claude (meta-tool: runtime modifies itself). Runtime hooks block these writes — bypass attempts (incl. `>`, `tee`, `node -e fs.writeFileSync`) fail loud. Your `--add-dir` flags are NOT carte blanche.

| Forbidden | Override flag (if any) |
|---|---|
| `state.json` / `state.json.tmp.*` (any session) | `allow_state_writes_reason` (schema migration only) |
| `LATEST_SCHEMA_VERSION` bump in `types/index.ts` / `.js` | schema-migration ticket + `_internalSchemaBump` |
| `pickle_settings.json` / `.tmp.*` | `allow_settings_writes_reason` |
| `circuit_breaker.json`, `pipeline-status.json` / `.tmp.*` | none |
| `bash install.sh` | none |
| `~/.claude/pickle-rick/**` | none |
| Other tickets' dirs | none |
| `spawnSync`/`spawn` without `timeout` | per-callsite |
| Orchestrator tokens (`EPIC_COMPLETED`, `TASK_COMPLETED`, `PRD_COMPLETE`, `TICKET_SELECTED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, `ANALYSIS_DONE`) | none — emit ONLY `<promise>I AM DONE</promise>` |

If your ticket seems to require one: STOP. Wrong scope OR override flag missing. Mark Skipped with `skipped_reason: "requires <flag> not set"`.

PRD: `prds/p1-worker-source-state-recursion-contamination.md`.

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pickle-rick-claude** (26447 symbols, 39140 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pickle-rick-claude/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pickle-rick-claude/clusters` | All functional areas |
| `gitnexus://repo/pickle-rick-claude/processes` | All execution flows |
| `gitnexus://repo/pickle-rick-claude/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
