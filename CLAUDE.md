# Pickle Rick for Claude Code

PRD → Breakdown → Research → Plan → Implement → Verify → Review → Simplify.

## ⛔ Worker Forbidden Ops (R-WSRC)

Meta-tool: workers run inside the runtime they're modifying. Runtime hooks enforce these; prose alone failed (`send-to-morty.md` NEVER rule was violated by R-QGSK-3 incident 2026-05-16).

| Forbidden write | Override flag | Runtime check |
|---|---|---|
| `state.json` / `state.json.tmp.*` | `allow_state_writes_reason` (schema migration only) | `state-manager.ts` ceiling + `config-protection.ts` hook |
| `LATEST_SCHEMA_VERSION` bump | schema-migration ticket + `_internalSchemaBump` flag | `state-manager.ts` + `install.sh` AC-RVN-08 |
| `pickle_settings.json` / `.tmp.*` | `allow_settings_writes_reason` | `config-protection.ts` hook |
| `circuit_breaker.json`, `pipeline-status.json` / `.tmp.*` | none | `config-protection.ts` hook |
| tsc errors at commit time | `allow_tsc_failed_reason` (manager-only) | `tsc-gate.ts` hook |
| `bash install.sh` from worker | none | bash-scanner |
| `~/.claude/pickle-rick/**` | none | `config-protection.ts` hook |
| Test `claude --add-dir <real-repo>` | none | `backend-spawn.ts` `PICKLE_TEST_MODE` + `audit-test-add-dir-containment.sh` |
| Other ticket's dir | none | `check-scope-diff.ts` preflight |
| `spawnSync`/`spawn` no `timeout` | per-callsite | Per-file trap doors |
| Orchestrator tokens (`EPIC_COMPLETED`, etc.) | none — workers emit only `<promise>I AM DONE</promise>` | `promise-tokens.ts` scrubber |

PRD: `prds/p1-worker-source-state-recursion-contamination.md`.
Closer manager handoff runbook: `docs/closer-ticket-manager-handoff.md` for manager-owned closer residuals after `closer_handoff_terminal` or `manager_handoff_pending`.

## Documentation Rule

When adding, removing, or modifying commands (`.claude/commands/*.md`), update `README.md`. Docs drift = bugs.

## Source of Truth

Canonical → Deployed (`bash install.sh` rsyncs, overwrites):
`extension/src/*.ts` → `~/.claude/pickle-rick/extension/**/*.js` | `.claude/commands/*.md` → `~/.claude/commands/*.md` | `pickle_settings.json` + `persona.md` → `~/.claude/pickle-rick/`

NEVER edit deployed files. Edit source, run `bash install.sh`.

## Generated Artifacts

DOT pipeline files (`*.dot`) and PRD files (`*.md` in `extension/`) are generated artifacts — do NOT commit them to this repo. They are consumed by the attractor server, not by this project. Add `*.dot` to `.gitignore`.
`extension/data/` — static JSON consumed by the plumbus-frame-analyzer (e.g., `engine-injected-keys.json`). Committed, not generated — edit source, not the deployed copy.

## Build & Test

cd extension && npm ci && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive
Tests: `extension/tests/*.test.js` via `node --test`. No `.test.ts` files.
Auxiliary npm scripts: `coverage` (c8 fast-tier baseline), `coverage:delta` (regression check via `scripts/coverage-delta.sh`), `wire-check` (gate parity via `scripts/check-wired.sh`).

## Required Patterns

CLI guard: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`
Hook decisions: `"approve"` or `"block"` only (never `"allow"`)
Error handling: `const msg = err instanceof Error ? err.message : String(err);`
Extension path: `~/.claude/pickle-rick` (never `.gemini`)

## Versioning

Semver `<Major>.<Minor>.<Patch>` in `extension/package.json`:
**Major** = breaking (state schema, CLI args, hook contracts) | **Minor** = features (commands, flags, prompts) | **Patch** = fixes, refactors
Bump → commit `chore: bump version to X.Y.Z` → `gh release create vX.Y.Z`
Before creating a release, run the full lint and test gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Test failures block release, no exceptions.
**All uncommitted changes MUST be committed and included before tagging a release.** No dirty working tree at release time — `git status` must be clean, compiled JS must match TS source.

## Architecture

| Script | Role |
|--------|------|
| dispatch.js | Hook entry, stdin JSON, spawns handler, fail-open |
| stop-hook.js | Checks state.json tokens, no lifecycle advance, tmux passthrough |
| setup.js | Session init (state.json, ticket dirs), first prompt |
| spawn-morty.js | Per-ticket `claude -p` subprocess |
| spawn-refinement-team.js | 3 parallel analysts/cycle, writes refinement_manifest.json |
| mux-runner.js | Context-clearing outer loop via tmux |
| jar-runner.js | Batch runner for jar queue |
| metrics.js + metrics-utils.js | Token/commit/LOC reporter, cache at `~/.claude/pickle-rick/metrics-cache.json` |
| monitor.js / log-watcher.js / morty-watcher.js / raw-morty.js | tmux TUI panes (Matrix-styled) |
| refinement-watcher.js | PRD refinement team monitor pane |
| microverse-runner.js + microverse-state.js | Metric convergence loop: measure, compare, rollback, stall detection |
| convergence-gate.ts | Gate service: runGate, filterByScope, assertBaselineFresh, baseline subtraction; invoked by check-gate / finalize-gate / microverse-runner |
| pipeline-runner.js | Sequential phase orchestrator: pickle → anatomy-park → szechuan-sauce |
| state-manager.js | Atomic file locks, crash recovery, schema migration, multi-file transactions |
| types/index.js | Shared types: State, errors (StateError/LockError/TransactionError), PromiseTokens, activity events |
| meeseeks.md | Setup + per-pass review template |

## Environment Variables

| Variable | Values | Effect |
|---|---|---|
| `PLUMBUS_GENERATIVE_AUDIT` | `"off"` | Kill-switch: bypasses Override 6 entirely — no analyzer invocation, no `## Generative Findings` written, logs `"generative_audit: skipped (kill-switch)"` to `state.json.activity` |
| `PICKLE_INSTALL_ROOT` | path (default `$HOME/.claude/pickle-rick`) | Override deploy prefix for `install.sh` and deploy-lifecycle soak test |
| `RUN_EXPENSIVE_TESTS` | `"1"` | Gates the `test:expensive` tier (deploy-lifecycle soak, release-gate full run). Must be set explicitly; not included in default `npm test` |
| `SOAK_SECONDS` | integer ≥ 1800 (default `1800`) | Duration for deploy-lifecycle soak test in `tests/integration/deploy-lifecycle-soak.test.js` |
| `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` | integer ms ≥ 60000 (default `600000` = 10 min) | Per-gate-phase cap for `npm run test:fast` / `test:integration` inside the worker lint gate (R-WTFT). Strict positive integer parse; values below the 60_000 ms floor clamp up; invalid values fall back to the default. Use to tune per-machine without redeploy when the fast suite legitimately exceeds 10 min on slow hardware. |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pickle-rick-claude** (25153 symbols, 37417 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
