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