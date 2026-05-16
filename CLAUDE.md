# Pickle Rick for Claude Code

PRD → Breakdown → Research → Plan → Implement → Verify → Review → Simplify.

## ⛔ Worker Forbidden Operations (R-WSRC)

**This codebase is a meta-tool that develops itself.** Workers run with full filesystem access to the running runtime. Certain operations corrupt the runtime mid-flight and MUST NEVER be performed by any worker (claude OR codex backend). Read this section before touching any file.

| Operation | Why forbidden | Override | Runtime trap door |
|---|---|---|---|
| Write to `<session>/state.json` or any `.tmp.<pid>` snapshot | A worker write trips `StateManager.recoverOrphanTmpFiles` promotion → the running mux-runner reads corrupted state and wedges (R-QGSK-3 incident 2026-05-16). The orphan-tmp promotion auto-renames any `.tmp.<dead-pid>` over `state.json`. | `state.flags.allow_state_writes_reason` (non-empty string) for schema-migration tickets only; emits `state_write_override_used` event per bypass | `extension/src/services/state-manager.ts` (R-WSRC-1 ceiling check at `update()` / `forceWrite()`) + `extension/src/hooks/handlers/config-protection.ts` (R-WSRC-3 PreToolUse hook) |
| Write to `circuit_breaker.json`, `pipeline-status.json`, or their `.tmp.*` snapshots | Worker writes change the circuit breaker state of the running pipeline; the breaker controls halt behavior. Pipeline-status corruption races the monitor's liveness probe. | none — hard prohibition | `extension/src/hooks/handlers/config-protection.ts` (R-WSRC-3) |
| Write to `pickle_settings.json` or its `.tmp.*` snapshots | Settings control tier budgets, timeout caps, and feature flags GLOBALLY. A worker write changes the behavior of every subsequent ticket and session. | `state.flags.allow_settings_writes_reason` (non-empty string); emits `state_write_override_used` event per bypass | `extension/src/hooks/handlers/config-protection.ts` (R-WSRC-3) |
| Bump `LATEST_SCHEMA_VERSION` in `extension/src/types/index.ts` (or its compiled mirror) | Source bump without coordinated deploy causes `assertSchemaVersionDeployParity()` to throw on every fresh-process state read. Compiled-mirror bump bypasses the install.sh parity gate. | Schema-migration ticket only, paired with the `_internalSchemaBump` migration helper in `StateManager`; coordinated `bash install.sh` deploy required in the same commit | `extension/src/services/state-manager.ts` (R-WSRC-1) + `install.sh` AC-RVN-08 parity gate |
| Run `bash install.sh` from inside a worker subprocess | Redeploys the running runtime mid-session. Any process holding `require()`-cached modules then runs torn code. The schema parity check is a startup-only invariant. | none — hard prohibition | (none yet; ship in R-WSRC-3 extended bash-scanner) |
| Write to `~/.claude/pickle-rick/**` (deployed runtime path) | Mid-session edits to deployed binaries invalidate in-memory module cache. `getExtensionRoot()` resolves to this path; it's passed in every worker's `--add-dir`, granting write access. | none — hard prohibition | `extension/src/hooks/handlers/config-protection.ts` (R-WSRC-3) |
| Spawn `claude --dangerously-skip-permissions --add-dir <real-repo>` from a test | Leaked subprocesses (R-MRWG-2 SIGTERM non-propagation) retain unrestricted write access to the operator's real working tree indefinitely. | none — test harness must use `os.tmpdir()`-rooted working_dir | `extension/src/services/backend-spawn.ts` (R-WSRC-4 PICKLE_TEST_MODE assertion) + `extension/scripts/audit-test-add-dir-containment.sh` |
| Write into another ticket's directory (`<session>/<other-ticket-hash>/`) | Cross-ticket writes corrupt sibling research/plan/conformance artifacts. The corrupted ticket may then be promoted to Done on stale evidence. | none — hard prohibition | `extension/src/bin/check-scope-diff.ts` (existing scope preflight) |
| Spawn child processes without a finite `timeout` option | Unbounded subprocesses outlive the worker's SIGTERM (R-MRWG-2 root cause). Hung child processes accumulate as launchd orphans. | none — pattern enforced per-callsite | Per-file trap doors (e.g., `src/bin/plumbus-frame-analyzer.ts`, `src/services/ac-phase-gate.ts`); B-MRWG bundle adds general-purpose check |
| Emit orchestrator promise tokens (`EPIC_COMPLETED`, `TASK_COMPLETED`, `PRD_COMPLETE`, `TICKET_SELECTED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, `ANALYSIS_DONE`) | Workers have no authority to claim epic-done, ticket-selected, review-clean, or analysis-done. Premature tokens advance pipeline state before work is real. Worker's ONLY valid completion is `<promise>I AM DONE</promise>`. | none — hard prohibition | `extension/src/services/promise-tokens.ts` `scrubForbiddenWorkerTokens` (runtime-blocked) |

**Defense-in-depth note**: prose alone is worthless (the existing `NEVER modify state.json` in `send-to-morty.md:61` was already there and was violated by R-QGSK-3). This table is paired with runtime trap doors that enforce the rules at the write site / read site / spawn site. The prose's job is to (a) make workers self-aware, (b) cite the runtime check so workers know it's real and not bypassable, (c) provide override discoverability for legitimate use cases.

**See**: `prds/p1-worker-source-state-recursion-contamination.md` for full bug class analysis and atomic ticket breakdown.

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
