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
| `bash install.sh` from worker | none | bash-scanner |
| `~/.claude/pickle-rick/**` | none | `config-protection.ts` hook |
| Test `claude --add-dir <real-repo>` | none | `backend-spawn.ts` `PICKLE_TEST_MODE` + `audit-test-add-dir-containment.sh` |
| Other ticket's dir | none | `check-scope-diff.ts` preflight |
| `spawnSync`/`spawn` no `timeout` | per-callsite | Per-file trap doors |
| Orchestrator tokens (`EPIC_COMPLETED`, etc.) | none — workers emit only `<promise>I AM DONE</promise>` | `promise-tokens.ts` scrubber |

PRD: `prds/p1-worker-source-state-recursion-contamination.md`.

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

cd extension && npm ci && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive
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
Before creating a release, run the full lint and test gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Test failures block release, no exceptions.
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

<!-- gitnexus:start -->
# GitNexus MCP

Indexed as **pickle-rick-claude** (341 symbols, 689 relationships, 12 flows).

1. Read `gitnexus://repo/{name}/context` — overview + freshness check
2. Match task to skill below, read that SKILL.md
3. Follow skill workflow. If index stale → `npx gitnexus analyze`

| Task | Skill |
|------|-------|
| How does X work? | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| What breaks if I change X? | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Why is X failing? | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename/extract/split/refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools/resources/schema ref | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index/status/clean/wiki CLI | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
