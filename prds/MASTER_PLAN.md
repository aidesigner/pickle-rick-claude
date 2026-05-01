# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Last updated**: 2026-05-01 (v1.64.0 released; v1.63.0 overnight bundle SHIPPED clean)

This file is **operational** — it tells the next coding agent what to work on. Historical narrative lives in:
- `docs/codex-prompt-design-notes.md` — codex-backend prompt-design lessons (FM-1..FM-4, literalism, scope confusion)
- Per-PRD `## Post-Validation Gaps` and `## Session Notes` sections — incident detail and validation results
- `git log` + release notes — release-by-release shipped detail

---

## 🔔 Active Queue (priority order)

| # | PRD | Status | Next action |
|---|---|---|---|
| 1 | [`prds/loop-runner-relaunch-status-bugs.md`](loop-runner-relaunch-status-bugs.md) | **In flight** — pickle loop running on session `2026-05-01-21605b33`, current_ticket `f316f495` | Watch for completion; recommended end-to-end test of v1.64.0 launcher refactor (touches `mux-runner.ts`, `monitor.ts`, `ensureMonitorWindow`) |
| 2 | [`prds/hermes-integration.md`](hermes-integration.md) | **Ready** — research complete (`prds/hermes-research.md`), 30 Qs answered, 4 open Qs resolved | `/pickle-refine-prd` → bundle into next overnight run |
| 3 | [`prds/multi-repo-task-state-drift.md`](multi-repo-task-state-drift.md) | **Refined draft** — high impact when triggered (multi-repo flows only) | Pick up after hermes; needs scoping decision |
| 4 | [`prds/god-functions-remediation-phase-2.md`](god-functions-remediation-phase-2.md) | **Draft** — 27 carve-outs from Phase 1 to remove; worst offender `runGate` (cyclomatic 65) | Refactor epic; bundle behind hermes |
| 5 | [`prds/deepseek-integration.md`](deepseek-integration.md) | **Draft** — third backend via Anthropic-compat shim (~230 LOC) | Lower priority than hermes (rides claude CLI) |

**Residuals** (not their own queue slot, will be swept opportunistically):
- AC-SSV-04, AC-SSV-06, AC-LPB-07, AC-RVN-11 (24h soak), AC-RVN-12 (self-propagation negative test) — see [`state-schema-version-ordering-incident.md`](state-schema-version-ordering-incident.md), [`large-pipeline-time-budget-undersized.md`](large-pipeline-time-budget-undersized.md), [`schema-version-deploy-reversion-rca.md`](schema-version-deploy-reversion-rca.md).
- Citadel post-validation gaps — see [`citadel.md`](citadel.md) `## Post-Validation Gaps`.

---

## 1. PRD Index

### Active (queued or in flight)

| Path | Status | Notes |
|---|---|---|
| `loop-runner-relaunch-status-bugs.md` | **In flight (P1)** | 3 bugs in mux-runner startup ordering, 12 ACs, 5 atomic tickets, ~400-500 LOC |
| `hermes-integration.md` + `hermes-research.md` | **Ready (P2)** | Fourth backend `'hermes'`; 12 FRs + 5 NFRs + ~20 new tests |
| `multi-repo-task-state-drift.md` | **Refined draft** | T1-T4 partially shipped pre-v1.63.0; remainder TBD |
| `god-functions-remediation-phase-2.md` | **Draft** | 27 god-fns × ~20 tickets to remove ESLint carve-outs |
| `deepseek-integration.md` | **Draft** | Third backend via DeepSeek's Anthropic-compat shim |
| `openrouter-multi-provider-workers.md` | **Draft** | Lower priority; no source impl |
| `tool-error-retry-tracking.md` | **Draft** | OMC Ralph-mode-inspired; intra-session tool-failure tracking |
| `smart-iteration-handoff.md` | **Refined draft** | Reduce wasted iterations 30%+ in microverse / 20%+ in tmux |

### Design docs (active, no immediate ship target)

| Path | Status | Notes |
|---|---|---|
| `citadel.md` | **Draft (BMAD-merged)** | Functional core SHIPPED via T04-T27 in v1.62.x; remaining gaps in `## Post-Validation Gaps` |
| `pickle-dot-codegen-builder.md` | Refined | `/pickle-dot` design doc (138KB; bloat candidate) |
| `pickle-dot-v8-iterate-support.md` | Ready | V8 iterate handler shipped attractor-side; dot-builder awareness pending |
| `pickle-dot-codegen-builder-bdd-scenarios.md` | Draft | BDD scenarios for codegen builder |
| `bdd-scenarios-auto-patterns.md` | Draft | Auto-pattern BDD scenarios |
| `convergence-v8-topology.md` | Refined | Topology design |
| `council-of-ricks-v1.50-json-directive.md` | Ready | Council JSON directive upgrade |
| `plumbus-generative-audit-frames.md` | Refined | A1-A6 generative audit frames |
| `pickle-agent-teams.md` | Draft | Phase 3 teams-mode alternative |

### Shipped (archive — no further action)

| Release | PRDs |
|---|---|
| **v1.64.0** (2026-05-01) | (no PRD — pickle-standup gaps + skill launcher fix + codex test shim + lint debt; release notes only) |
| **v1.63.0** (2026-05-01) | `overnight-bug-bundle.md` (9/9 done in 109m on codex), `anatomy-park-finalizer-history-crash.md` (T1), `microverse-runner-stall-resilience.md` (T5), `large-tier-stall-recovery.md` T-A+T-B (T3+T4), `anatomy-park-followups.md` Sub-fix A+C (T6+T2) |
| **v1.62.x** (2026-04-30) | `state-schema-version-ordering-incident.md`, `large-pipeline-time-budget-undersized.md`, `schema-version-deploy-reversion-rca.md`, BMAD wave T04-T27 (under `citadel.md`) |
| **v1.59.x** (2026-04-29) | `god-functions-remediation.md` T0-T19 (16 impl + 4 hardening); codex stall hardening |
| **v1.58.0** (2026-04-28) | `convergence-toolchain-gates.md` (25 atomic tickets, 122 commits, +19,597/-1,921 LOC) |
| **v1.57.0** (2026-04-27) | Cronenberg meta-router (no PRD; designed inline) |
| **v1.56.x** (2026-04-26) | `codex-classifier-prompt-leak.md`; T0 of god-fn epic; pipeline robustness fixes |
| **Earlier** | `watcher-pane-recovery.md` (rolled into citadel-hardening-bundle), `citadel-hardening-bundle.md` (75/75 tickets done in `pipeline-1204204c`) |

---

## 2. Recently Shipped (last 2 releases)

### v1.64.0 (2026-05-01) — operator hygiene

- `pickle-standup` skill: closed 5 gaps surfaced live (open-PR query, product-voice lint, epic grouping, drift footer, helper-noise drop list). Linear MCP cross-reference shipped.
- 4 skill launchers (`/anatomy-park`, `/szechuan-sauce`, `/pickle-microverse`, `/plumbus`) refactored: launch microverse-runner via session-local `launch.sh` instead of brittle inline `tmux send-keys` heredocs (zsh silently mis-parsed multi-line `if/elif/fi` chains).
- Codex test shim derives version from `engines.codex` so future engine-pin bumps don't rot the fixture.
- Pre-existing lint debt cleared (8 errors → 0). Two `complexity` violations deferred to god-functions-remediation-phase-2 rows 28-29.
- Test suite: 3464/3464 pass. ESLint: 0 errors.

### v1.63.0 (2026-05-01) — overnight bug bundle

- 9-ticket bundle on codex backend at session `2026-04-30-bc104e78` (109m): APH residual finalizer fix (T1), codex-manager-relaunch service extraction (T2), tier-aware circuit-breaker budget (T3), send-to-morty Resume Detection (T4), microverse stall resilience (T5), trap-door catalog hygiene (T6), test-floor aggregator (T7), parametrized trap-door conformance lint (T8), refinement-time symbol audit (T9).
- `--skip-readiness <reason>` flag (BMAD residual P0.6) shipped as Agent A bundle (commit `deac6c5`).
- Anatomy-park audit on the diff converged clean in 2 iterations on session `2026-05-01-9ccab218` (0 confident findings, 8 candidates dropped at conf<80).

---

## 3. Current State (verified 2026-05-01)

| Item | Value |
|---|---|
| Latest release | **v1.64.0** |
| Working tree | clean (loop session works in worktrees) |
| `tsc --noEmit` | clean |
| `eslint src/ --max-warnings=-1` | 0 errors |
| Test suite | **3464/3464 pass** |
| Active loop session | `2026-05-01-21605b33` (loop-runner-relaunch-status-bugs.md, current_ticket `f316f495`) |
| Codex backend | production-grade (75-ticket Citadel bundle + 9-ticket overnight bundle both shipped autonomously) |
| `CODEX_MANAGER_RELAUNCH_CAP` | 10 (raised from 5; `extension/src/types/index.ts`) |

---

## 4. Resume Strategy

- **Active loop**: idempotent on `state.step` / `state.current_ticket`. If the loop exits, relaunch with `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
- **New work**: `/pickle-refine-prd <prd-path>` → review manifest → `/pickle-tmux <prd-path>` (3+ tickets) or `/pickle <prd-path>` (1-2). Backend defaults to claude; append `--backend codex` for refactor epics.
- **Pipelines**: `/pickle-pipeline <prd-path>` runs `pickle → anatomy-park → szechuan-sauce`. Sequential phase orchestrator at `pipeline-runner.ts`.

---

## 5. Cross-cutting Engineering Rules

These apply to every PR in the codebase. Detail in `extension/CLAUDE.md` and `prds/citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR. Independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`. Must be clean before tag.
3. **Source-of-truth discipline** — edit `extension/src/*.ts` and `.claude/commands/*.md` only; run `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every documented invariant in `extension/CLAUDE.md` has an enforcing test. Don't break the catalog.
5. **Hook decisions** — `"approve"` or `"block"` only (never `"allow"`).
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries only.
8. **Versioning** — semver in `extension/package.json`. Major = breaking (state schema, CLI args, hook contracts); minor = features; patch = fixes. Single bump per epic, at the closer ticket.
9. **No dirty release** — uncommitted changes MUST be committed before tagging. `git status` must be clean; compiled JS must match TS source.
10. **Greenfield discipline** — no legacy aliases, no backward-compat shims for removed code.

For codex backend specifics, see `docs/codex-prompt-design-notes.md`.

---

## 6. Quick Reference

```bash
# Active loop (in flight)
SESSION_ROOT=~/.local/share/pickle-rick/sessions/2026-05-01-21605b33
tail -f $SESSION_ROOT/tmux-runner.log
tmux attach -t $(basename $SESSION_ROOT | cut -c12-)   # session name = trailing hash

# Metrics
node ~/.claude/pickle-rick/extension/bin/metrics.js          # token/commit/LOC report
/pickle-status                                                # formatted current session
/pickle-metrics                                               # aggregate report

# New work
/pickle-prd                                                   # interview → PRD
/pickle-refine-prd <prd-path>                                 # 3-cycle decomposition
/pickle-tmux <prd-path>                                       # 3+ tickets
/pickle <prd-path>                                            # 1-2 tickets, interactive
/pickle-pipeline <prd-path>                                   # full pipeline (pickle→anatomy-park→szechuan-sauce)

# Releases
gh release create vX.Y.Z                                      # tag + publish
git fetch --tags                                              # sync local tags (gh-created tags lag)
```

### Latest release links

- **v1.64.0** — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.64.0
- **v1.63.0** — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.63.0
