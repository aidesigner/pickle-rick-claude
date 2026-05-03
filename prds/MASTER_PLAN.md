# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Last updated**: 2026-05-03 PM (**v1.69.0 RELEASED** — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.69.0. 138 commits pushed v1.66.0..HEAD; install.sh ran clean; src/dep parity OK at 1.69.0. Mega bundle 34/34 tickets shipped via session `2026-05-02-fca7952b` over ~10h on codex. Stuck `pipeline-fca7952b` tmux session is gone. Pipeline phase 2/4 anatomy-park never started this run — codex manager spins bootstrap loop on empty-queue (NEW bug `p2-codex-manager-empty-queue-spin.md`). pkg.json-only-revert bug (NEW class `p1-deployed-pkgjson-version-only-revert.md`) bites every 30-60 min in flight — operator workaround = manual `bash install.sh` + ts symlink restore.)

**Bootstrap for new sessions**: read `CONTEXT_2026-05-03.md` first.

This file is **operational** — it tells the next coding agent what to work on. Historical narrative lives in:
- `docs/codex-prompt-design-notes.md` — codex-backend prompt-design lessons (FM-1..FM-4, literalism, scope confusion)
- Per-PRD `## Post-Validation Gaps` and `## Session Notes` sections — incident detail and validation results
- `git log` + release notes — release-by-release shipped detail

---

## 🔔 Active Queue (priority order)

| # | PRD | Status | Next action |
|---|---|---|---|
| 1 | [`prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md`](p1-reliability-and-test-coverage-bundle-2026-05-03.md) ⭐ **P1 BUNDLE — REFINED, IN FLIGHT** | **Refined cycle 3 — relaunch pending** — composes the 4 open bug PRDs (Sections A–D) plus Section E (R-RTC-1..R-RTC-18 after refinement). Refinement produced 38 tickets (33 implementation + 1 wiring + 4 hardening) on session `2026-05-03-7d9ee8cc`. **First launch crashed at iteration 1** when check-readiness rejected 30+ contract refs across 9 tickets — all forward-created bundle artifacts (`QUARANTINE.md`, `ci.yml`, `demote()`, etc.), path-resolution misses (`release.yml` bare vs `.github/workflows/release.yml`), stdlib APIs (`t.todo()`, `fs.utimes`), JSON output fields, and test-defined helpers. 4 parallel review agents now editing tickets to un-backtick forward refs / use full paths before relaunch. NEW peer bug `prds/p2-refined-tickets-trip-readiness-contract-resolver.md` filed for the meta-issue. | After 4 review agents complete: `state.flags.skip_readiness_reason=null` → bash launch.sh relaunch in tmux pipeline-7d9ee8cc:0 |
| 1a | [`prds/p1-deployed-pkgjson-version-only-revert.md`](p1-deployed-pkgjson-version-only-revert.md) | **Composed into bundle Section A** | Land via bundle |
| 1b | [`prds/p2-codex-manager-empty-queue-spin.md`](p2-codex-manager-empty-queue-spin.md) | **Composed into bundle Section B** | Land via bundle |
| 1c | [`prds/p3-paused-session-orphan-blocks-stop-hook.md`](p3-paused-session-orphan-blocks-stop-hook.md) | **Composed into bundle Section C** | Land via bundle |
| 1d | [`prds/p3-test-flakes-council-publish-and-scope-resolver.md`](p3-test-flakes-council-publish-and-scope-resolver.md) | **Composed into bundle Section D** | Land via bundle |
| 1e | [`prds/p2-refined-tickets-trip-readiness-contract-resolver.md`](p2-refined-tickets-trip-readiness-contract-resolver.md) ⭐ **NEW P2** | **Draft** — readiness contract resolver fails on 5 false-positive classes: bundle-created forward refs, path-resolution misses, stdlib APIs, JSON output fields, test-defined helpers. 6 R-RTRC requirements: refinement-team prompt update + resolver allowlist + (created by ticket) annotation pattern + `tests/` inclusion in resolveSymbolRef + git-ls-files suffix fallback in resolvePathRef + regression fixture. Surfaced live by reliability-bundle session `2026-05-03-7d9ee8cc` first-launch crash. | Bundle into next overnight after reliability bundle ships |
| 2 | [`prds/p2-mega-bundle-2026-05-02-pm.md`](p2-mega-bundle-2026-05-02-pm.md) **MEGA BUNDLE** | **Refined Cycle 3 — IN FLIGHT** — composes 6 source PRDs (strip + state-drift + retry-tracking + smart-handoff + hermes + god-fn-phase-2). 34 atomic tickets refined; pipeline relaunched after readiness halt with `state.flags.skip_readiness_reason` bypass; PHASE 1/4 PICKLE codex active. Cron `2ba30074` armed every hour at :17. | Babysit until closer reaches v1.69.0 |
| 2 | [`prds/p1-strip-excessive-defense-deploy-reversion.md`](p1-strip-excessive-defense-deploy-reversion.md) | **In mega bundle Section A** | Will land via mega bundle |
| 3 | [`prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md`](p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md) | **30/30 tickets SHIPPED** in code on session `2026-05-02-ad240987` (codex backend). All commits in main. Closer DEFERRED live release because env lacks `crontab` permission. v1.67.0 will NOT be tagged; v1.68.0 ships directly OR rolls into v1.69.0 via mega bundle closer. | Tag in mega bundle closer |
| 3 | [`prds/p1-bug-bundle-2026-05-01-pm.md`](p1-bug-bundle-2026-05-01-pm.md) | **All 20 tickets DONE** — closer landed v1.67.0 commit `2c814e8`. Source pkg.json still at 1.67.0. v1.67.0 **NOT tagged on GitHub** (Cycle 3 verdict: skip; ship v1.68.0 directly). | Closed by strip-then-v1.68.0 release |
| 4 | [`prds/anatomy-park-gate-baseline-missing.md`](anatomy-park-gate-baseline-missing.md) | **SHIPPED v1.66.0** + Section B of P0 bundle adds event-based assertion (`baseline_recapture_attempted`/`_succeeded`). | Verified by P0 bundle's AC-DR-02 once v1.68.0 deployed and a real anatomy-park run executes |
| 5 | [`prds/hermes-integration.md`](hermes-integration.md) | **Ready (P2)** — research complete, 30 Qs answered | `/pickle-refine-prd` → next overnight bundle after v1.68.0 ships |
| 6 | [`prds/multi-repo-task-state-drift.md`](multi-repo-task-state-drift.md) | **Refined draft** — high impact when triggered (multi-repo flows only) | Pick up after hermes |
| 7 | [`prds/god-functions-remediation-phase-2.md`](god-functions-remediation-phase-2.md) | **Draft** — 27 carve-outs from Phase 1 to remove | Refactor epic; bundle behind hermes |
| 8 | [`prds/deepseek-integration.md`](deepseek-integration.md) | **Draft** — third backend via Anthropic-compat shim | Lower priority than hermes |
| 9 | (proposed) `prds/package-json-deploy-parity-gap.md` | **Not yet drafted** — engines.codex source/deploy drift; AC-RVN-08 doesn't cover package.json | Draft alongside hermes |

**Residuals** (not their own queue slot, will be swept opportunistically):
- AC-SSV-04, AC-SSV-06, AC-LPB-07, AC-RVN-11 (24h soak), AC-RVN-12 (self-propagation negative test) — see [`state-schema-version-ordering-incident.md`](state-schema-version-ordering-incident.md), [`large-pipeline-time-budget-undersized.md`](large-pipeline-time-budget-undersized.md), [`schema-version-deploy-reversion-rca.md`](schema-version-deploy-reversion-rca.md).
- **`check-readiness.ts` snapshot tmp recovery** — anatomy-park found this HIGH-confidence on session `21605b33` and trap-doored it (`extension/CLAUDE.md`, line 12), but no fix commit landed because anatomy-park exited at iter 2. Independently fixed by anatomy-park on session `c9595747` (commit `97a57c2`).
- ~~**Anatomy-park gate-baseline missing-after-commit**~~ — promoted to P1 **`prds/anatomy-park-gate-baseline-missing.md`** (queue slot #1) after recurring on session `c9595747`. Was a residual on the prior MASTER_PLAN; recurrence proves it's a hard 100% failure mode.
- Citadel post-validation gaps — see [`citadel.md`](citadel.md) `## Post-Validation Gaps`.

---

## 1. PRD Index

### Active (queued or in flight)

| Path | Status | Notes |
|---|---|---|
| `p1-deployed-pkgjson-version-only-revert.md` | **Draft (P1) ⭐ NEW** | NEW deploy-revert bug class: pkg.json:version field reverts while file content-hashes match. Diagnostic-first |
| `p2-mega-bundle-2026-05-02-pm.md` | **Refined (P2) — IN FLIGHT on session `fca7952b`** | 6-PRD mega bundle: strip + state-drift + retry + handoff + hermes + god-fn-2; 34 tickets |
| `p1-strip-excessive-defense-deploy-reversion.md` | **In mega bundle Section A** | Drafted; will land via mega bundle |
| `p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md` | **30/30 SHIPPED in code** (session `2026-05-02-ad240987`, codex) | Refined PRD has 17 ACs; closer DEFERRED live release. v1.68.0 untagged pending strip |
| `p1-bug-bundle-2026-05-01-pm.md` | **20/20 SHIPPED** (closer commit `2c814e8`, source v1.67.0) | Anatomy-park failed downstream of deploy-reversion. v1.67.0 will NOT be tagged; v1.68.0 ships directly |
| `readiness-gate-manifest-prd-bundle-mismatch.md` | **SHIPPED via P0 bundle** Section D (commits in main) | AC-RGM-01..07 all green; bundle PRDs no longer need `--skip-readiness` |
| `pipeline-runner-state-active-not-claimed-on-relaunch.md` | **SHIPPED via P0 bundle** Section C (commits in main) | state.active claim-on-relaunch + section-c-still-needed.js gate |
| `anatomy-park-runner-undefined-description-crash.md` | **SHIPPED via P1 bundle** (commits `bddcb71`, `be5dacf`, `cee66e9`, `c8f14d7`, `17623ea`) | All 5 ACs Done; assertMicroverseStateShape + history guards landed |
| `szechuan-sauce-codex-judge-model-mismatch.md` | **SHIPPED via P1 bundle** (commits `aa2336c`, `a590b97`, `f2d938b`, `0357d29`, `26cbf98`, `effe287`, `74f463d`) | All 5 ACs Done; one-line fix at init-microverse.ts:13 + judge_unreachable exit |
| `pipeline-state-desync-and-pane-respawn-tmpdir.md` | **SHIPPED via P1 bundle** (commits `cde1175`, `9a9c9f5`, `145eaea`, `c82c181`, `f55f46c`, `47904e7`, `622cd53`, `674016b`) | T0..T5 in v1.66.0; T6..T10 in v1.67.0 closer commit |
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
| **(uncommitted, planned v1.65.0)** | `loop-runner-relaunch-status-bugs.md` SHIPPED via session `21605b33` (5 atomic tickets, 6 commits `087930e..67a2ca0`); standalone `ac-phase-gate.timeout` fix at `d5270c0`; doc-rationalization commits at `7b5e4df`. Anatomy-park trap-doored 2 findings on `21605b33` (commits `2c70e8c`-era CLAUDE.md updates) but exited at iter 2 with gate-baseline failure; szechuan-sauce 4/4 never ran. Awaits release gate + tag. |
| **v1.64.0** (2026-05-01) | (no PRD — pickle-standup gaps + skill launcher fix + codex test shim + lint debt; release notes only) |
| **v1.63.0** (2026-05-01) | `overnight-bug-bundle.md` (9/9 done in 109m on codex), `anatomy-park-finalizer-history-crash.md` (T1), `microverse-runner-stall-resilience.md` (T5), `large-tier-stall-recovery.md` T-A+T-B (T3+T4), `anatomy-park-followups.md` Sub-fix A+C (T6+T2) |
| **v1.62.x** (2026-04-30) | `state-schema-version-ordering-incident.md`, `large-pipeline-time-budget-undersized.md`, `schema-version-deploy-reversion-rca.md`, BMAD wave T04-T27 (under `citadel.md`) |
| **v1.59.x** (2026-04-29) | `god-functions-remediation.md` T0-T19 (16 impl + 4 hardening); codex stall hardening |
| **v1.58.0** (2026-04-28) | `convergence-toolchain-gates.md` (25 atomic tickets, 122 commits, +19,597/-1,921 LOC) |
| **v1.57.0** (2026-04-27) | Cronenberg meta-router (no PRD; designed inline) |
| **v1.56.x** (2026-04-26) | `codex-classifier-prompt-leak.md`; T0 of god-fn epic; pipeline robustness fixes |
| **Earlier** | `watcher-pane-recovery.md` (rolled into citadel-hardening-bundle), `citadel-hardening-bundle.md` (75/75 tickets done in `pipeline-1204204c`) |

---

## 2. Recently Shipped (last 3 releases)

### v1.69.0 (2026-05-03 PM) — mega bundle release ceremony

- **Released** at https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.69.0. Rolls up v1.67.0 (P1 bundle: anatomy-park crash + szechuan judge + pipeline-state-desync tail), v1.68.0 (P0 deploy-reversion bundle: 30 tickets + strip + trap-door fixes), and v1.69.0 closer (mega bundle 34/34 from session `fca7952b`: strip + state-drift + retry-tracking + smart-handoff + hermes + god-fn-2 + backend identity + teams validation).
- 138 commits pushed v1.66.0..HEAD. install.sh clean; src/dep parity OK at 1.69.0.
- **Known pre-existing test failures (not regressions, predate v1.66.0):** `tests/council-publish.test.js:867` (hung `gh pr comment` timeout asserts 1 call, observes 2) and `tests/scope-resolver-import-walks.test.js:111` (rg→grep fallback returns false locally). Filed as `p3-test-flakes-council-publish-and-scope-resolver.md`.

### Uncommitted (planned v1.68.0) — P0 deploy-reversion bundle (30 tickets) + P1 strip-back + trap-door fixes

- **30/30 P0 bundle tickets DONE** in code on session `2026-05-02-ad240987` (codex backend, ~9h end-to-end). Section A (14 lockdown tickets), Section B (2 gate-baseline event + verifier), Section C (2 state.active claim + re-eval), Section D (3 readiness manifest), infra (2 verify-bundle + force-vs-allow matrix), wiring, 4 hardening (HT-1..HT-4), closer, scheduled-soak.
- **Tickets that needed retry**: A.8 (mux-runner pre-flight, c56ab4a7) and A.10 (downgrade UX, 01504f22) failed first pass due to codex's strict full-suite gate; both passed on retry after `state.flags.skip_readiness_reason` bypass for the readiness gate (the bundle PRD itself triggered the very `readiness-gate-manifest-prd-bundle-mismatch.md` bug it ships a fix for — meta).
- **Closer DEFERRED live release**: `bash install.sh` hangs on `crontab` install (sandbox restriction); full `npm test` blocks on pre-existing `trap-door-conformance.test.js` failures (`extension/CLAUDE.md` lines 9, 13, 64, 76). Pkg.json still at 1.67.0; v1.68.0 not tagged on GitHub; v1.66.0 still GitHub-Latest with poison content.
- **NEW P1 strip PRD** (`prds/p1-strip-excessive-defense-deploy-reversion.md`) drops ~480 LOC of cron sampler + scheduled-soak + mux-runner pre-flight before tagging. Codebase analyst Cycle 3 already noted only AC-DR-04c is the actual fix; the rest is defense-in-depth for an unidentified writer class.
- **Trap-door fixes via 2-agent team** (uncommitted): split lines 9+13 of `extension/CLAUDE.md` into separate bullets (one INVARIANT/BREAKS/ENFORCE triple per bullet); created stub tests `extension/tests/mux-runner-state-iteration.test.js` (4 tests) and `extension/tests/get-extension-root-fallback.test.js` (3 tests). `trap-door-conformance.test.js` now 25/25.
- **Phantom session cleanup**: orphan session `2026-05-02-9e48bce6` left active by an agent's test run, deactivated to unblock stop-hook.
- Babysit cron `a3a6970f` ran 18 cycles redeploying every 30min — confirmed live the deploy-reversion bug bites continuously (~every 15-20min before A.14 force-write kill-switch landed mid-pipeline).

### Uncommitted (planned v1.67.0) — P1 bundle (anatomy-park crash + szechuan judge model + pipeline-state-desync tail)

- **All 20 tickets DONE** on session `2026-05-01-325ccb80` over two pickle phases (initial 144m + retry). Closer commit `2c814e8` bumped 1.66.0 → 1.67.0.
- Section A (anatomy-park-runner-undefined-description-crash): 5 ACs shipped (`be5dacf`, `bddcb71`, `cee66e9`, `c8f14d7`, `17623ea`). `assertMicroverseStateShape` runtime validator added; history-access guards; regression test.
- Section B (szechuan-sauce-codex-judge-model-mismatch): 5 ACs shipped (`aa2336c`, `a590b97`, `f2d938b`, `0357d29`, `26cbf98`, `effe287`, `74f463d`). One-line fix at `init-microverse.ts:13`; convergence guard against empty history; new `judge_unreachable` exit reason.
- Section C tail (pipeline-state-desync T6..T10): 5 tickets shipped (`47904e7`, `f55f46c`, `622cd53`, `674016b`, `c82c181`, `145eaea`, `9a9c9f5`, `cde1175`). EXTENSION_DIR opt-in renamed to EXTENSION_DIR_TEST; ESLint rule for bare reads; integration test; trap-door catalog.
- Plus 4 hardening tickets (H1-H4: code quality, data flow, test quality, cross-reference) + 4 anatomy-park bonus commits during the failed phase.
- **Why pipeline reported FAILED**: anatomy-park exited at iter 2 with the same gate-baseline-missing bug v1.66.0 was supposed to fix. Forensic finding: deployed extension was reverted v1.66.0 → v1.64.0 by auto-updater between install.sh and pipeline launch. **The deploy-reversion meta-bug masked all this work as if it were broken.** All 20 tickets ARE shipped in source; the pipeline phase verification failed because the runtime ran stale JS.
- v1.67.0 **NOT yet tagged** on GitHub. Held until P0 bundle ships F7 lockdown.

### v1.66.0 (2026-05-01) — anatomy-park gate-baseline missing-after-commit

- 9 atomic tickets shipped in 91m on session `bfa25a4b`. Gate-baseline write-verify, recapture-before-strict-mode, strict-red routed through stall-limit, integration test, trap-door catalog. AC-RVN-08 deploy-parity assertion already in place — but reversion happens at the auto-updater, not at install.sh.
- Tagged: `gh release create v1.66.0` on 2026-05-01 22:35 UTC. Latest on GitHub.

### Uncommitted (planned v1.65.0) — relaunch status hygiene + ac-phase-gate timeout

- **`loop-runner-relaunch-status-bugs.md` SHIPPED** via `/pickle-pipeline --backend codex` on session `2026-05-01-21605b33`. 5 atomic tickets, 6 commits `087930e..67a2ca0`. Bug A (mux-runner ownership ordering vs `ensureMonitorWindow`), Bug B (monitor pane-0 recovery), Bug C (stale `exit_reason` on relaunch + phase transition).
- Pipeline result: pickle ✓ (3 iter, 41m), citadel ✓ (1 finding), anatomy-park ✗ (iter 2, gate-baseline missing-after-commit, exit 1), szechuan-sauce never ran. Anatomy-park trap-doored 2 HIGH findings: `ac-phase-gate command-timeout` (independently fixed at commit `d5270c0`) and `check-readiness-snapshot recovery` (still open as P3 residual).
- **Standalone `ac-phase-gate.timeout` fix** at commit `d5270c0` — adds `timeout_ms?` field per AC criterion + 30-min default; threaded through `spawnSync`. New trap-door INVARIANT in `extension/CLAUDE.md` with PATTERN_SHAPE.
- **Doc rationalization** at commit `7b5e4df` — MASTER_PLAN 554→160 lines, citadel.md 1103→689 lines, BMAD appendix split out, codex prompt-design notes moved to `docs/`.
- **Test suite**: still 3464/3464 (loop-runner work added tests; counts in pipeline run). ESLint: 0 errors.
- Awaits release gate (`tsc --noEmit && eslint && tsc && npm test`) + version bump + `gh release create v1.65.0`.

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

## 3. Current State (verified 2026-05-03 PM)

| Item | Value |
|---|---|
| Source version | **v1.69.0** (commit `bdc775f`) — mega bundle closer |
| Deployed version | **v1.69.0** (parity OK after fresh `install.sh`; flips back to 1.64.0 every 30-60 min per pkg.json-only-revert bug — monitor via `jq -r .version $HOME/.claude/pickle-rick/extension/package.json`) |
| Latest release on GitHub | **v1.69.0** ✅ (released 2026-05-03 PM with full v1.66.0..HEAD release notes; v1.67.0/v1.68.0 source bumps rolled into v1.69.0) |
| Branch state | `main`, **synced with `origin/main`** (138 commits pushed in release ceremony) |
| Working tree | CLEAN |
| Active pipeline session | NONE — stuck `pipeline-fca7952b` tmux session has exited; mega bundle session dir retained at `~/.local/share/pickle-rick/sessions/2026-05-02-fca7952b/` for postmortem |
| P0 bundle session retained | `~/.local/share/pickle-rick/sessions/2026-05-02-ad240987/` — 30 ticket dirs + bundle artifacts |
| Mega bundle session retained | `~/.local/share/pickle-rick/sessions/2026-05-02-fca7952b/` — 34 ticket dirs |
| Cron watchdogs | NONE — `2ba30074` (1h babysit) cancelled after closer Done. `a3a6970f` (30min P0 babysit) cancelled earlier |
| Codex backend | production-grade |
| `CODEX_MANAGER_RELAUNCH_CAP` | 10 |
| `engines.codex` pin | `^0.128.0` (source); deployed re-synced via the latest install.sh |
| Today's bug logs | P0 bundle shipped + P1 strip PRD drafted |
| Test suite | strip-PRD blocking on pre-existing trap-door entries (NOW FIXED uncommitted by agent team); needs full re-run after strip+commit |

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
# P0 bundle session (completed, retained for postmortem)
SESSION_ROOT=~/.local/share/pickle-rick/sessions/2026-05-02-ad240987
ls $SESSION_ROOT/bundle/                                      # AC artifacts
cat $SESSION_ROOT/refinement_summary.md                       # Cycle-3 analyst summary

# Strip PRD work (manual surgical, no pipeline)
cat prds/p1-strip-excessive-defense-deploy-reversion.md       # 12 ACs, ~480 LOC removal target

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
