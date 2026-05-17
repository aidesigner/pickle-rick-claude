# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Last updated**: 2026-05-17 AM (CDT) — v1.75.2 B-CTSF SHIPPED (R-CTSF-1..4 in 71m wall over 10 iterations — closer ownership tags, mux-runner terminal closer-handoff detection, auto-resume stop on closer handoff, closer template compliance audit + manager-handoff runbook). Finding #44 R-CTSF CLOSED. **B-QSRC residuals (R-QGSK + R-RSU from B2-RSU partial-ship-halt) next P1.** Historical narrative pre-2026-05-15 → `prds/MASTER_PLAN-archive.md`.

## State of the world (for /clear resume)

**Active**: none. B-CTSF just shipped as v1.75.2 (4 tickets in 71m via codex backend, fresh mux-runner directly under tmux — NOT under codex manager, avoided the R-CCPM-Phase-1b hallucinated-recursion-killer that ate the prior session yesterday). B-MRWG shipped v1.75.1 prior. B2-RSU `pipeline-c543d227` PARTIAL-SHIP-HALTED at 57% (11 R-codes shipped, R-QGSK + R-RSU residuals deferred to **B-QSRC** queue slot — DO NOT relaunch B2 session). **B-QSRC is the next P1.**

Closer manager handoff runbook: `docs/closer-ticket-manager-handoff.md`.

**Shipped today (2026-05-15)**:
- AM: **R-RHGS** bundle (8 tickets) — closed Findings #36 R-SRTS / #38 R-PRCR / #41 R-RMBS; partial-closed #37 R-PIWG (R-PIWG-3 worktree + R-PIWG-5 lsof deferred). Commits `81861358..6f635a8d`.
- AM: **R-CCPM** (5/10 substantive) — closed Finding #1 (R-CCPL successor via H-D codex-setup.js-as-actions). Commits `f915b821`/`690e5c5c`/`e955ce4d`/`39a660e4`/`73657d27`. R-CCPM-WH wiring + 4 hardening parked as P3 follow-up (slot 38).
- PM: **B2 in-flight** — R-MWCL-1 `3ac31602` (inferMonitorMode covers all 6 modes incl. `'refinement'`); R-MWCL-2 `dfaf9dcc` deferred (contradictory AC, R-MDS-3 already wires checkAndSwapMode). v1.74.0 at deploy.

**Operator directive 2026-05-15 PM** — **bug-fix-only sequence** (B1–B13 in the queue table below). Features deferred: R-MFW (MCP forwarding), R-GBK (Grok backend), R-MBSR (refinement clustering), Hermes/Deepseek/OpenRouter, methodology PRDs.

**Verify-then-close audit 2026-05-15 PM** (against HEAD) discovered six B-bundle pieces shipped but unbookkept:
| Already shipped | Evidence |
|---|---|
| B1 R-MBLE + R-SLLJ | `microverse-baseline-classification.test.js` 6/6 pass; allowlist split + violation_ledger + R-SLLJ-9 LLM-gating |
| B2 R-APMW | `handleWorkerSubprocessError` + `WORKER_CONSECUTIVE_ERROR_CAP=3` + `OUTPUT_STALL_SECONDS=1800` |
| B3 R-ICDM-1 | `detectManagerMaxTurnsExit` returns `eventTurns >= maxTurns` (mux-runner.ts:1466) |
| B11 R-MDS | `respawnMonitorWindowForMode` at phase boundaries (pipeline-runner.ts:2187-2191) |
| B12 R-SOA | `signal_received` event + `active_child_pid` payload |
| B12 R-POD | `getPausedOrphanDemotion` returns composite `shouldDemote` |

**Filed today**:
- **Finding #27 R-MMRT promoted P3→P2** with new cascade evidence (empty-sessionDir + temp-dir-sessionDir). PRD `prds/p2-mux-runner-monitor-respawn-uses-temp-dir-not-session-root.md` (R-MMRT-1..6, ~6 tickets, ~half-day).
- B2 bundle PRD `prds/p2-bug-fix-bundle-2026-05-15-operational-trifecta-plus-rsu.md` (22 atomic impl + 4 hardening + 1 closer).

**Active monitor cascade bug** (R-MMRT): currently biting B2 — monitor window collapsed from 4 panes → 1 mid-run because `restartDeadWatcherPanes` / `respawnMonitorWindowForMode` don't validate `sessionDir`. Pipeline logic unaffected (workers + manager continue in window 0); operator-visibility degraded. **Co-bundle target with R-MWCL** after B2 closes (shared `pickle-utils.ts` + `monitor.ts` surface).

**Skip flags active in B2** (`state.flags`): `skip_readiness_reason` + `skip_ticket_audit_reason` set with R-FRA/R-RTRC-7 justification — 47 forward-create gate findings exempted (25 file_path + 3 contract + 16 performance warnings; all legitimate AC outputs). This bundle ships R-QGSK collapsing both flags into one.

**Operational notes**:
- `worker_timeout_seconds` drifted 2400→1200 at relaunch despite explicit `--worker-timeout 2400`. Known drift bug; workers may hit 20m timeout mid-`npm run test:fast` and self-retry. R-PHC `continue_on_phase_fail` ensures pipeline doesn't abort.
- Bundle PRD inline-enumerates each R-code as its own section (defense against R-RSU section-umbrella collapse — refinement decomposes section-by-section rather than via the broken composes-walker fanout). 22-ticket flat decomposition succeeded.
- First launch died at 1m 8s on READINESS HALT (forward-create gate noise); recovery applied skip flags + relaunched cleanly at 18:00:18Z.

**Resume after /clear**:
```bash
SESSION_ROOT="/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-15-c543d227"
jq '{step,iteration,current_ticket,active,exit_reason}' ${SESSION_ROOT}/state.json
git -C /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude log --oneline -10
tmux list-windows -t pipeline-c543d227
```

**ETA**: ~14-22h pickle (26 tickets × 30-45 min codex) + 1-2h citadel/anatomy/szechuan = **~16-24h total wall-clock**. Pace observed: 3 commits in first 43m (R-MWCL-1 + R-MWCL-2-defer + R-MMRT PRD).

This file is **operational** — it tells the next coding agent what to work on. Historical narrative lives in:
- `docs/codex-prompt-design-notes.md` — codex-backend prompt-design lessons (FM-1..FM-4, literalism, scope confusion)
- Per-PRD `## Post-Validation Gaps` and `## Session Notes` sections — incident detail and validation results
- `git log` + release notes — release-by-release shipped detail

---

## 🛑 Working Rules (read before queueing work)

1. **Bugs first, scope second.** Open bugs in PRDs and master-plan queue slots must be drained before any feature/expansion work is queued. Bundle assembly **must** pull from open-bug lists first; new feature PRDs are deferred until the open-bug count is below an explicit threshold (current ceiling: **≤ 3 P1/P2 bugs open**, counted against the Active Queue + Active PRD Index). Override requires an operator-stated reason recorded in the queue row (e.g., "feature unblocks customer X" or "bug class needs the new infrastructure to land first") — silent prioritization of features over open bugs is not allowed.
2. **Worker tickets must run the lint + typecheck + fast-test gate before completion-commit.** Workers commit code with the `completion_commit:` contract, but multiple sessions (incl. `pipeline-e0834dcd` 2026-05-06) have shipped tickets that left ESLint, `tsc --noEmit`, and sometimes the fast tier red — caught only when the operator ran the release gate later. Worker prompts must include `npx eslint src/ --max-warnings=-1 && npx tsc --noEmit && npm run test:fast` ahead of the completion commit; failure blocks the commit. Workers get one auto-fix retry only for lint and tsc, plus one targeted-fix retry for test failures where the worker reads the failing test names, runs them in isolation, fixes the issue, and re-runs the full `test:fast`.
3. **The pipeline's first design goal is to keep working and complete its queued phases.** Test/lint/conformance regressions are expected mid-bundle — `citadel`, `anatomy-park`, and `szechuan-sauce` phases exist exactly to remediate them automatically. Halting the pipeline before remediation phases run defeats the automation. Default behavior (once Finding #22 R-PHC ships): `state.pipeline_continue_on_phase_fail: true`; only `--strict-phases` opt-in changes this. Operator never needs to file a tertiary remediation bundle for failures that downstream phases could clean up on the same run.
4. **Test reliability is a hard prereq for feature bundles.** If `npm run test:fast` is not reliably 10/10 green under `--test-concurrency=8` against the full ~4500-test suite, do not launch a feature bundle. Period. The DEFERRED-cascade pathology costs more than the feature is worth.
5. **At most one PRD per pipeline session.** No mixed-PRD bundles ever again. Both c122b0f7 (9 PRDs) and historically-large bundles collapsed before draining family 1. One PRD, ≤8 tickets, ship cleanly, repeat.
6. **Estimate wall-clock at 30-45 minutes per ticket with codex backend** (observed reality from c122b0f7 and c71ab3ca). The optimistic 10-15 min/ticket assumption that drove the "feature bundle in 1-2 hours" plan has been falsified twice. Plan accordingly.
7. **Heal-via-edit doesn't work mid-iteration.** The runner overwrites operator edits to `state.json` / ticket files between iterations. Force-skip only flips a ticket to terminal status if the runner sees terminal status during its own ticket-selection phase, which is hard to hit reliably. Don't try operator heals on a running pipeline; stop the pipeline first, edit, then relaunch with `--resume`.
8. **Trust measured diagnosis over PRD-author hypothesis.** PRDs that pre-list root-cause hypotheses (e.g. R-TSPF's "Common pattern — race on shared fixture paths") *bias the worker toward those hypotheses even when the code falsifies them*. R-TSPF-1 found `mkdtemp+realpathSync` already in place at `council-publish.test.js:46` — the leading hypothesis was structurally impossible for that test — and re-classified the real race as `load-dependent-timeout`. Both R-ARSF and R-TSPF independently rediscovered this. Fix the pattern at refinement time: rename "Common pattern" sections to "Hypothesized race classes (R-TSPF-1 must MEASURE, not assume)" and require diagnostic tickets to assign the measured class per finding, not match against the hypothesis list. Workers under deadline pressure treat PRD hypotheses as authoritative.

---

## 📅 Historical session narratives — see `prds/MASTER_PLAN-archive.md`

2026-05-07 PM status (post-Theme-A + post-hardening): v1.72.2 installed locally; 2026-05-07-deferred-slots bundle SHIPPED 4 slots + closer (closed Findings #1/#3/#4); Theme A pipeline `pipeline-be6e9179` SHIPPED 9/9 sections (closed Findings #2/#6); 12-commit post-Theme-A hardening sweep (closed Findings #8/#9). All production gates GREEN at `da43416f`. Standalone anatomy-park `2026-05-07-4ca7a746` ran 21/50; pipeline-killer class fixed via `b0f5ceca`.

## 🔥 Open findings (refreshed 2026-05-15 PM)

Closed-finding detail → `MASTER_PLAN-archive.md`. Open findings carry a one-line summary + PRD pointer.

### Open (P1)

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 25 | R-CSI | Concurrent claude-session destructive-command interference; 3 SIGINT incidents in 36h | `prds/p1-concurrent-claude-session-interference-with-running-pipelines.md`. Phase 1 forensics deferred per operator 2026-05-15 PM ("wait for next incident") |
| 27 | R-MMRT | Monitor respawn uses temp-dir/empty sessionDir → 4-pane window collapse cascade. **Biting B2 NOW.** | `prds/p2-mux-runner-monitor-respawn-uses-temp-dir-not-session-root.md` (R-MMRT-1..6). Promoted P3→P2 2026-05-15 PM. **B-MONITOR co-bundle target with R-MWCL after B2 closes.** |
| 28 | R-ICDM | claude iteration classifier `detectManagerMaxTurnsExit` misuse | R-ICDM-1 ✅ shipped today (verify-then-close, `mux-runner.ts:1466` `eventTurns >= maxTurns`). R-ICDM-2..7 audit needed |
_(42 R-MRWG closed in v1.75.1 — see Closed table below)_
_(43 R-WSRC closed in v1.75.0 — see Closed table below)_
_(44 R-CTSF closed in v1.75.2 — see Closed table below)_

### Newly observed (P1, not yet refined)

| Code | Summary | Notes |
|---|---|---|
| R-CCPM-1b | Codex manager hallucinates "recursive manager child" wedge on its own healthy mux-runner subprocess and sends SIGTERM to kill it. Observed 2026-05-16 21:46Z killing B-CTSF iter 7 mid-implement; captured-pane evidence: codex emitted "The existing mux-runner is wedged on a recursive manager child" then mux-runner.log shows "Received SIGTERM — deactivating session". Codex was mistaking worker_session log proliferation for nested-manager recursion. | Phase-1b residual of R-CCPM closed family. PRD not yet filed. Workaround: run mux-runner directly under tmux pane, not under codex manager. |

### Open (P2)

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 11 | R-APWS | anatomy-park worker edits bypass `scope.json:allowed_paths` at fix time | `prds/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md` (R-APWS-1..7). Lack-of-paper-trail class, not data-loss |
| 12 | R-PSAI | `/pickle-pipeline` skill ignores branch/subset signals in operator kickoff | `prds/p2-pickle-pipeline-no-scope-auto-inference.md` (R-PSAI-1..7) |
| 18 | R-FGNC | finalize-gate classifier mistakes `.npmrc` env-var WARN for real failures; masks real lint/TS errors | `prds/p2-szechuan-anatomy-finalize-gate-npmrc-warn-pollution-masks-real-failures.md` (R-FGNC-1..7). Operator workaround: `export GITHUB_PACKAGES_TOKEN=anything` |
| 30 | R-RSU | refinement collapses `composes:` bundle PRDs to N section-umbrellas | IN-FLIGHT B2 (R-RSU-1..5, order 170-210) |
| 33 | R-WMW | manager wedges on oversized ticket; spawns worker but no artifact progress | `prds/p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md` (R-WMW-1..6) |
| 39 | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool availability check | **PRD not yet drafted**; ~4 tickets, ~half-day |
| 40 | R-VSGE | verification commands containing shell-special chars (`[id]`, `(group)`, `*`, `?`) error under zsh glob expansion | **PRD not yet drafted**; ~4 tickets, ~half-day |

### Open (P3)

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 5 | — | Subsystem CLAUDE.md drift; audit 5 subsystems under `extension/src/` | No PRD; audit task |
| 19 | R-MMTR | claude manager max-turns family closeout pending | R-MMTR-1/5 shipped; R-MMTR-2/3/4 Skipped+completion_commit (heal via R-MMTRH); R-MMTR-6 force-skipped (re-attempt via R-MMTR6S); R-MMTR-7 closer pending |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | IN-FLIGHT B2 (R-MWCL-1 ✅ `3ac31602`; R-MWCL-2 deferred `dfaf9dcc`; R-MWCL-3..7 in flight) |
| 32 | R-TFP | `npm run test:fast` parallel-load flakes (4 tests under `--test-concurrency=8`) | `prds/p3-test-fast-parallel-load-flakes.md` (R-TFP-1..5) |
| 34 | R-WTB | `Defaults.WORKER_TIMEOUT_SECONDS: 1200` too short for R-PTG worker lifecycle | IN-FLIGHT B2 (R-WTB-1..4, order 80-110) |
| 37(e) | R-PIWG-5 | git-isolation residual: `lsof` launch-time concurrent-access probe | R-PIWG-3 (worktree) **DROPPED per operator 2026-05-15** ("no worktrees in pickle runs"). R-PIWG-5 only, ~2-3 tickets |

### Followup (P1, deferred per operator 2026-05-15)

**R-CCDC** (successor to R-CCNW), `prds/p1-citadel-detection-coverage-silent-gate-pass.md`. Stage 1 forensic + Stage 2 ≤4 tickets. Citadel ran 1.3s with 288 findings/exit 0 on b54f2143 while anatomy-park then shipped 6 CRITICAL + 22 HIGH on the same diff, including 3 silent-gate-pass CRITICALs of the exact class T3/T6/T8 were designed to catch. Deferred per operator ("maybe later").

### Closed (full detail in `MASTER_PLAN-archive.md`)

✅ #1 R-CCPL/R-CCPM (2026-05-15) · #2 codex Done-without-commit · #3 R-APBS · #4 R-ICM · #6 /pickle-standup · #8 test:fast fork-bomb · #9 spawn-morty readdir-hang · #10 R-APBN baseline fresh-init · #13 R-MJCP probe · #14 R-CCNW citadel wiring (2026-05-14) · #15 R-MDS monitor dashboard (2026-05-15) · #16 R-PRJT (absorbed by R-MBLE 2026-05-15) · #17 R-SLLJ (2026-05-15) · #20 R-SOA (2026-05-15) · #21 R-PTG · #22 R-PHC · #23 R-APMW (2026-05-15) · #24 R-SAOV · #26 R-MBLE (2026-05-15) · #31 R-POD (2026-05-15) · #36 R-SRTS (R-RHGS 2026-05-15) · #37(a-d) R-PIWG sub-claims (R-RHGS 2026-05-15) · #38 R-PRCR (R-RHGS 2026-05-15) · #41 R-RMBS (R-RHGS 2026-05-15) · **#44 R-CTSF (v1.75.2 2026-05-17 AM: B-CTSF R-CTSF-1..4 shipped — 4df162c8 closer ownership tags + worker handoff conformance, 390e9096 helper for closer handoff terminal exits, b2a3bc22 mux-runner terminal closer-handoff detection, 43693967 auto-resume stop on closer handoff exit_reasons, c2be6291 closer template compliance audit + docs/closer-ticket-manager-handoff.md runbook. Refinement collapsed R-CTSF-5/6 into R-CTSF-4. 71m wall, 10 iterations. R-CCPM-1b codex-manager-hallucination class observed mid-run and noted as new Open finding.)** · **#42 R-MRWG (v1.75.1 2026-05-16 PM: B-MRWG R-MRWG-1..5 shipped — d6bd60cb→1f9f8b3c bounded between-ticket fast-test gate; 17624f23→7b892fb9 kill worker-gate npm descendants on timeout; 9c9288d4→a95d6988 sync mux-runner stall event parity; ab90b539→41f90715 reap orphan fast-test runners on startup; ba56b9b9→b225fe06 add pipeline-runner child stall heartbeat. R-MRWG-6 closer worker-scope work `aaac2d57` + manager-owned residuals (version bump / install.sh / MASTER_PLAN) shipped post-manual-handoff after R-CTSF spin observed.)** · **#43 R-WSRC (v1.75.0 2026-05-16: B-WSRC R-WSRC-1..5 shipped; R-WSRC-6 closer merged into v1.75.0 release; 47/47 regression tests pass; bug class definitively closed via StateManager schema-ceiling + mux-runner schema-ahead exit + PreToolUse hook + bash-scanner + test-harness add-dir containment + CLAUDE.md/AGENTS.md/send-to-morty.md forbidden-ops sections)**

---

## 🔔 Active Queue — Bug-fix-only sequence (refreshed 2026-05-15 PM)

**Operator directive 2026-05-15 PM**: drain bug queue before features. Features deferred to `## Future epics` (R-MFW, R-GBK, R-MBSR, Hermes/Deepseek/OpenRouter, methodology PRDs). Sanctioned multi-PRD shared-file-surface bundles permitted at ≤14 tickets/bundle (Phase 1b precedent).

**In-flight**: B2-RSU `pipeline-c543d227` resumed 2026-05-16 09:37 CDT post-wedge recovery. 12 Done / 1 Skipped / 12 Todo / 1 In Progress (`22c36bf6` iter 1). Healed tickets `8240fdca` (`189d4d2f` 2026-05-15 PM) + `1d385443` (`b2ddf584` 2026-05-16 AM) — both via heal-via-edit-then-resume after R-MRWG wedges.

| Bundle | Status | Composes | Tickets | Notes |
|---|---|---|---|---|
| **B2-RSU** (active) | 🟡 IN-FLIGHT | R-MWCL + R-WTB + R-QGSK + R-RSU | 22+4 | Operational tax trifecta + refinement unblock. **Wedged 13h overnight 2026-05-15→2026-05-16 on R-MRWG (see Finding #42).** R-MWCL-1 ✅ `3ac31602`; R-MWCL-2 deferred `dfaf9dcc`; R-MWCL-6 ✅ `189d4d2f` (healed); R-QGSK-2 ✅ `b2ddf584` (healed). **Closes Findings #29/#30/#34 + slot #29 on success.** |
| **B-MRWG** | ✅ SHIPPED v1.75.1 | R-MRWG (Finding #42) | 6 | Shipped 2026-05-16 PM in v1.75.1. R-MRWG-1 `1f9f8b3c` bounded between-ticket fast-test gate; R-MRWG-2 `7b892fb9` kill worker-gate npm descendants on timeout; R-MRWG-3 `a95d6988` sync mux-runner stall event parity; R-MRWG-4 `41f90715` reap orphan fast-test runners on startup; R-MRWG-5 `b225fe06` pipeline-runner child stall heartbeat; R-MRWG-6 closer worker `aaac2d57` (lint blockers cleared) + manager-owned closure (version bump + install.sh + this MASTER_PLAN edit). **Closes Finding #42.** **Closer-spin observed during R-MRWG-6 → new Finding #44 R-CTSF filed.** |
| **B-CTSF** | ✅ SHIPPED v1.75.2 | R-CTSF (Finding #44) | 4 | Shipped 2026-05-17 AM in v1.75.2. R-CTSF-1 `4df162c8` closer ownership tags + worker handoff conformance; helper `390e9096` Add closer handoff terminal exits; R-CTSF-2 `b2a3bc22` mux-runner terminal closer-handoff detection; R-CTSF-3 `43693967` auto-resume stop on closer handoff exit_reasons; R-CTSF-4 `c2be6291` closer template compliance audit + `docs/closer-ticket-manager-handoff.md` runbook. Refinement collapsed R-CTSF-5/6 into R-CTSF-4. Manager-owned closure (this bump + install + MASTER_PLAN edit) shipped post-handoff. **Closes Finding #44.** **R-CCPM-1b observed during prior session iter 7 — codex manager hallucinated "recursive manager child" wedge and SIGTERM'd healthy mux-runner; workaround: run mux-runner directly under tmux, not under codex.** |
| **B-QSRC** | 🔴 NEXT (P1, await operator) | R-QGSK + R-RSU residuals from B2-RSU partial-ship-halt | ~6-10 | B2-RSU partial-ship-halted 57% — 11 R-codes shipped, residuals deferred. Cannot relaunch B2 session `2026-05-15-c543d227`; new bundle PRD needs scoping. Closes residuals of Findings #29 / #30 / #34. |
| **B-WSRC** | ✅ SHIPPED v1.75.0 | R-WSRC (Finding #43) | 6 | Shipped 2026-05-16 in v1.75.0. R-WSRC-1..4 via 4-agent parallel team (commit `e0d37d1c`); R-WSRC-5 docs in `ce41ce3e` (slimmed in `718a2af2`); R-WSRC-6 closer merged into v1.75.0 release. 47/47 regression tests pass. Plus R-QGSK-2 followup fix for `resolveQualityGateSkipReason` legacy-flag bug discovered during R-WSRC-4 implementation. **Closes Finding #43.** |
| **B-MONITOR** | 🟢 QUEUED | R-MMRT + R-MWCL residuals | ~6-10 | R-MMRT (Finding #27, P2, PRD filed 2026-05-15) fixes monitor sessionDir validation; cascade-killed the B2 monitor mid-run. Co-bundle with any R-MWCL residuals not absorbed by B2 (R-MWCL-3..7). Shared `pickle-utils.ts` + `monitor.ts` surface. **Demoted from NEXT in favor of B-MRWG (P1 pipeline-bricking).** |
| **B-R-MMTR** | 🟢 QUEUED | R-ICDM-2..7 + R-MMTRH heal + R-MMTR-7 closer | ~6-8 | R-ICDM-1 shipped today. Audit R-ICDM-2..7 against HEAD (likely verify-then-close); heal R-MMTR-2/3/4 Skipped→Done; closer writes version-bump + parity. **Closes Findings #19 + #28.** |
| **B-E2E** | 🟢 QUEUED | R-MMTR6S | 4 sub | E2E re-attempt of force-skipped R-MMTR-6: fixture / harness / cases / CI wiring. Ships after B-R-MMTR closer. |
| **B-GATE** | 🟢 QUEUED | R-FGNC + R-PVTA + R-VSGE | ≤8 | P2 gate classifier + verification command robustness. **R-PVTA + R-VSGE need PRDs drafted** (sketches in Findings #39/#40). **Closes Findings #18/#39/#40.** |
| **B-WEDGE** | 🟢 QUEUED | R-RSU residuals + R-WMW | ~6 | P2 — only fires if B2's R-RSU doesn't fully close Finding #30. R-WMW per-ticket artifact-progress tracker (auto-skip oversized tickets at K=5 zero-artifact spawns). **Closes Findings #30 + #33.** |
| **B-FLAKE** | 🟢 QUEUED | R-TFP | 5 | P3 — `npm run test:fast` parallel-load flakes residual. Stops release-gate flickering. **Closes Finding #32.** |
| **B-LSOF** | 🟢 QUEUED | R-PIWG-5 | 2-3 | P3 — `lsof` launch-time concurrent-git-process probe. R-PIWG-3 worktree dropped per operator. **Closes deferred sub-claim (e) of Finding #37.** |
| **B-CSI** | ⏸ DEFERRED | R-CSI Phase 1 + Phase 2 | 10 | P1 forensics + prevention. Per operator: wait for next sibling-session incident to inform Phase 2 scope; Phase 1 forensics on existing 3 incidents may not yield enough signal. **Defer.** |
| **B-CCDC** | ⏸ DEFERRED | R-CCDC Stage 1+2 | ≤5 | P1 citadel detection-coverage successor. Per operator: maybe-later. |
| **B-AUDIT** | 🟢 QUEUED | Subsystem CLAUDE.md drift (Finding #5) | ad-hoc | No PRD; audit 5 subsystems under `extension/src/`. ~half-day. |

**Verify-then-close audit summary (2026-05-15 PM)**: B1 R-MBLE+R-SLLJ (Findings #16/#17/#26 + slots #9/#10), B2 R-APMW (Finding #23), B3 R-ICDM-1, B11 R-MDS (Finding #15), B12 R-SOA (Finding #20), B12 R-POD (Finding #31) — all already at HEAD.


### Future epics (deferred, not bug-fix, do not count toward open-bug ceiling)

- `prds/hermes-integration.md` — P2 feature, ready
- `prds/deepseek-integration.md` — P3 feature, draft
- `prds/openrouter-multi-provider-workers.md` — P3 feature
- `prds/god-functions-remediation-phase-2.md` — refactor epic, 27 carve-outs
- `prds/portal-gun.md`, `prds/pickle-debate.md`, `prds/pickle-microverse.md` — methodology PRDs

**Residuals** (not their own queue slot, will be swept opportunistically):
- AC-SSV-04, AC-SSV-06, AC-LPB-07, AC-RVN-11 (24h soak), AC-RVN-12 (self-propagation negative test) — see [`state-schema-version-ordering-incident.md`](state-schema-version-ordering-incident.md), [`large-pipeline-time-budget-undersized.md`](large-pipeline-time-budget-undersized.md), [`schema-version-deploy-reversion-rca.md`](schema-version-deploy-reversion-rca.md).
- **`check-readiness.ts` snapshot tmp recovery** — anatomy-park found this HIGH-confidence on session `21605b33` and trap-doored it (`extension/CLAUDE.md`, line 12), but no fix commit landed because anatomy-park exited at iter 2. Independently fixed by anatomy-park on session `c9595747` (commit `97a57c2`).
- ~~**Anatomy-park gate-baseline missing-after-commit**~~ — promoted to P1 **`prds/anatomy-park-gate-baseline-missing.md`** (queue slot #1) after recurring on session `c9595747`. Was a residual on the prior MASTER_PLAN; recurrence proves it's a hard 100% failure mode.
- Citadel post-validation gaps — see [`citadel.md`](citadel.md) `## Post-Validation Gaps`.

---

## 1. PRD Index

### Active (queued or in flight)

The operational queue is `## 🔔 Active Queue` above. This section lists open PRDs that aren't already in that queue.

| Path | Status | Notes |
|---|---|---|
| `p1-worker-source-state-recursion-contamination.md` | **✅ SHIPPED v1.75.0 2026-05-16** | R-WSRC-1..6 all shipped. Single-PRD bundle delivered via 4-agent parallel team + 4-agent debate analysis. 47/47 regression tests pass. |
| `p1-mux-runner-wedges-13h-on-unbounded-between-ticket-gate-spawnsync.md` | **✅ SHIPPED v1.75.1 2026-05-16** | R-MRWG-1..6 all shipped. B-MRWG bundle delivered via single-PRD pipeline; closer R-MRWG-6 worker-scope `aaac2d57` + manager-owned post-handoff residuals. |
| `p1-closer-ticket-spins-on-r-wsrc-forbidden-acs.md` | **✅ SHIPPED v1.75.2 2026-05-17** | R-CTSF-1..4 shipped (refinement collapsed 5/6 into 4). B-CTSF bundle delivered. Manager-owned residuals post-handoff. |
| `p1-codex-manager-prompt-pollution.md` | **Refined (P1)** | R-CCPM Phase 1a-bis successor to R-CCPL. Stage 1 forensic at `prds/research-r-ccpl-7fe6da60-2026-05-15.md` selects hypothesis H-D (codex executes operator-facing setup.js examples as actions). 5 atomic tickets, single-PRD bundle. Filed 2026-05-15 at commit `6f635a8d`. |
| `p1-deployed-pkgjson-version-only-revert.md` | **Diagnosis-only (P1)** | Deploy-revert bug class: pkg.json:version reverts while file content-hashes match. Research at `prds/research-slot-K-pjv-writer-2026-05-07.md`. |
| `p1-strip-excessive-defense-deploy-reversion.md` | **Partial** | Cron sampler stripped (`c2ec3cf1`); ~480 LOC of mux pre-flight, scheduled finalizer, launch-gate verifier still queued. |
| `multi-repo-task-state-drift.md` | **Refined draft** | T1-T4 partially shipped pre-v1.63.0; remainder TBD. Queued in follow-up bundle. |
| `tool-error-retry-tracking.md` | **Draft** | OMC Ralph-mode-inspired intra-session tool-failure tracking. |
| `smart-iteration-handoff.md` | **Refined draft** | Reduce wasted iterations 30%+ in microverse / 20%+ in tmux. |

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
| `council-of-ricks-catalog-mode-and-publish-fixes.md` | **Draft** | Reframe Council as cataloging (drop convergence model), fix publish-on-circuit-open + round-loss-on-breaker bugs, add `--filter-severity` to `council-publish.js`. Drafted from session `2026-05-11-425c52fb` (loanlight-api PR #1286, 7 rounds, no convergence — confirmed category error in v1.50 protocol). 10 atomic R-CMR-* requirements. |
| `plumbus-generative-audit-frames.md` | Refined | A1-A6 generative audit frames |
| `pickle-agent-teams.md` | Draft | Phase 3 teams-mode alternative |

### Shipped (archive — no further action)

| Release | PRDs |
|---|---|
| **v1.74.0 + 2026-05-15 R-RHGS ad-hoc ship** | `resume-heal-and-git-safety-bundle-2026-05-14.md` (R-RHGS) — 8/8 atomic tickets Done across 11 commits at `81861358..6f635a8d`. R-SRTS-1 (`81861358`), R-PIWG-1 (`b1fa7cac`+`7929cf64`), R-PIWG-2 (`7d2f2af6`), R-PIWG-4 (`c285e633`), R-PIWG-6 (`2d83f071`), R-PRCR-1 (`aabd72b4`), R-RMBS-1/R-RMBS-3 (`e1f79be9`); followups: anatomy-park `dafbe219` HIGH @tier directive fix, szechuan-sauce `d9e70bd2`+`d09c098f` docstring cleanups, chore `7ae41e5c` dead-init removal. Closes findings #36/#38/#41; partial-closes #37 (sub-claim (e) R-PIWG-3 worktree isolation deferred). Filed ad-hoc from external bug report 2026-05-14, not in original plan. |
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

### v1.74.0 (2026-05-11 / 2026-05-12 closer refresh / 2026-05-13 R-MMTR partial-ship / 2026-05-13 c71ab3ca R-ARSF ship) — reliability mega bundle + c122b0f7 R-MMTR family + R-ARSF auto-resume flake stabilization

- **2026-05-13 R-ARSF ship (session `2026-05-13-c71ab3ca`, codex backend, 2h 36min wall-clock)**: 3-ticket R-ARSF PRD refined inline by pickle phase, all 3 tickets Done. R-ARSF-1 (`1f27d1ff`) substantive @ `5f8857ce` (stabilize auto-resume stop-condition test harness inputs). R-ARSF-2 (`58dde215`) Done @ `610fd7f8` but **orphan commit with empty diff** — the substantive R-ARSF-2 banner-past-3 parallel-flake fix is bundled INTO `5f8857ce`, so no work was lost. R-ARSF-3 (`e6691081`) substantive @ `fd4bc791` — 10 files / 136+ insertions, includes regression guardrails for the auto-resume banner fix AND a bonus fix to `mux-runner.output-stall.spec.js` (R-APMW-6 territory). Reflog showed the R-ARSF-3 worker did 4 `git reset --hard` retry cycles before landing — survival pattern, not a bug. Pipeline stopped manually via SIGTERM after pickle phase completed (anatomy-park transition not run). Deployed via `bash install.sh --override-active`; src + deployed at v1.74.0. **Caveat (filed as R-TSPF, commit `b36b22e1`)**: `auto-resume.stop-conditions.test.js` now passes 5/5 in isolation under `--test-concurrency=8`, but **full `npm run test:fast` still fails on 5 tests** under parallel load — the original auto-resume banner case plus 4 unrelated flakes (`council-publish`, `ensureMonitorWindow` ×2, `mux-runner-relaunch`). R-ARSF achieved ~50% of its goal: isolation green, suite still flakes. The unblocker is now R-TSPF, not R-ARSF alone.
- **Sessions**: `2026-05-11-e1a3a5dd` (codex, reliability quartet closer); `2026-05-13-c122b0f7` (codex, R-MMTR family ship from 9-PRD mega-bundle that stopped at family 1/9); `2026-05-13-c71ab3ca` (codex, R-ARSF 3-ticket ship — pickle-only).
- **2026-05-13 commits (R-MMTR family on `main`)**: `f6772986` R-MMTR-1 (`ecebb5d2` Done, detect claude manager max-turns exit signature); `42148351` R-MMTR-2 (`d97acb1e` Skipped+commit, generalize manager relaunch caps; AC-7 deferred on R-ARSF flake); `5c7d089c` + `e601bc19` R-MMTR-3 (`f9f3ace5` Skipped+commit, enforce mux-runner max-turns relaunch contract; AC-7 deferred); `053f6fa6` R-MMTR-4 (`05c47442` Skipped+commit, manager_max_turns_relaunch schema event; AC-7 deferred); `6a05adea` R-MMTR-5 (`7b5a55db` Done, pin claude max-turns trap door). R-MMTR-6 (`fd1fff6c` E2E regression) force-skipped at 21:35Z after 80min wedge; R-MMTR-7 closer never reached.
- **Deploy**: `bash install.sh --override-active` ran post-R-MMTR-5; source + deployed both at `v1.74.0`. Heal path for R-MMTR-2/3/4 + R-MMTR-7 closer queued in upcoming Bundle 3 (R-MMTRH).
- **Bundle status**: `prds/p1-bug-fix-bundle-2026-05-12-mega.md` shipped in HEAD (2026-05-12); 2026-05-13's 9-PRD mega-bundle composed but only the R-MMTR section landed before throughput collapse.
- **Closed findings in this closer window**: #21 (R-PTG per-ticket worker gate now includes `test:fast`) and #22 (R-PHC continue-on-fail remediation policy ships by default). Finding #19 (R-MMTR) advances to PARTIAL-SHIPPED (1+5 Done, 2/3/4 deferred, 6 force-skip, 7 not-reached).
- **Findings intentionally left open**: #14, #15, #17 remain open pending the separate remediation / quality bundle. R-ARSF / R-MMTR6S / R-MMTRH / R-ASCH filed 2026-05-13 as follow-ons.
- **Deploy note**: install.sh remains the canonical deploy path; the 2026-05-12 closer reran `bash install.sh --closer-context --no-confirm` and re-verified md5 parity for `extension/bin/pipeline-runner.js`, `extension/bin/check-readiness.js`, `extension/types/index.js`, and the rebuilt `extension/bin/subsystem-watcher.js` deploy mirror. 2026-05-13 deploy used `--override-active` (active session was the source of the ship).

### v1.73.0 (2026-05-09) — 2026-05-08-mega bundle (11/11 sections + closer)

- **Session**: `2026-05-09-7ff82595` (claude backend, ~5h end-to-end with worker-stall remediation by manager-side validation).
- **Bundle commit range**: `ef3b2855..6851f41f` — 10 atomic commits.
- **11 tickets shipped**: Section A (a687a05a — bundle bootstrap + DIAGNOSE disposition), Section B (f3bf3c86 — codex classifier prompt leak R-CCPL-1..6), Section C (5f7192c4 — szechuan judge model claude-routed R-SCJM-1..6), Section D (1ffc21c9 — anatomy-park scope.json edit-time preflight R-APWS-1..7), Section E (e789b21c — /pickle-pipeline scope auto-inference R-PSAI-1..7), Section F (ea802022 — recoverable-json readdir bound R-RJR-1..3), Section G (2bc35531 — subsystem CLAUDE.md drift audit R-CMD-1..4), Section H (8c4d691a — pkgjson version-only revert DIAGNOSE R-PJV-1..6), Section I (1073f7ac — R-SED-1..7 → DROP, premise absent at HEAD), Section J (3941449a — microverse judge probe ETIMEDOUT misclassification R-MJCP-1..8), Section K (a7fa5858 — closer: version 1.73.0 + deploy parity + MASTER_PLAN bookkeeping R-CLOSER-1..3).
- **Open Findings closed**: #11 (anatomy-park edit-time scope), #12 (pickle-pipeline scope auto-inference), #13 (microverse judge ETIMEDOUT), #16 (recoverable-json readdir bound).
- **Open Findings deferred**: #5 (subsystem CLAUDE.md drift) — audit script + JSON report + 5 follow-up DRAFT PRDs (`prds/p3-subsystem-claude-md-{bin,hooks,lib,services,types}.md`) landed; remediation queued.
- **install.sh** ran with `--closer-context` (active-bundle override). md5-parity 5/5 OK across `extension/types/index.js`, `extension/services/state-manager.js`, `extension/bin/spawn-morty.js`, `extension/bin/mux-runner.js`, `extension/services/pickle-utils.js`. Deployed `~/.claude/pickle-rick/extension/package.json:version` = `1.73.0`.
- **Operator note**: workers timed out at 1200s on most tickets, but produced complete artifacts before the timeout; manager validated gates (tsc + eslint + targeted tests) and committed. Timeout root-cause is in spawn-morty / claude-CLI invocation, not in any single ticket — separately filed for follow-up.
- **Release tag**: NOT pushed to GitHub (default per AC-CLOSER-04; local-only mode preserved).

### Older releases (v1.63.0 → v1.69.0)

Forensic detail moved to `prds/MASTER_PLAN-archive.md`. Quick map:

| Release | Date | Source / commit |
|---|---|---|
| v1.69.0 | 2026-05-03 | mega bundle ceremony (rolls up v1.67/v1.68/v1.69 closer; 138 commits v1.66.0..HEAD) |
| v1.68.0 | uncommitted | P0 deploy-reversion bundle 30/30 (session `2026-05-02-ad240987`) |
| v1.67.0 | uncommitted | P1 anatomy-park crash + szechuan judge + pipeline-state-desync tail (session `2026-05-01-325ccb80`); closer `2c814e8` |
| v1.66.0 | 2026-05-01 | anatomy-park gate-baseline missing (9 tickets, session `bfa25a4b`) |
| v1.65.0 | uncommitted | loop-runner-relaunch-status-bugs (5 tickets `087930e..67a2ca0`) + `ac-phase-gate.timeout` `d5270c0` + doc rationalization `7b5e4df` |
| v1.64.0 | 2026-05-01 | operator hygiene (pickle-standup gaps + 4 skill-launcher refactor) |
| v1.63.0 | 2026-05-01 | overnight bundle (9 tickets T1-T9, session `2026-04-30-bc104e78`) + `--skip-readiness` flag (`deac6c5`) |

---

## 3. Current State (verified 2026-05-15 PM)

| Item | Value |
|---|---|
| Source version | **v1.74.0** — R-RHGS bundle ship + R-CCPM 5/10 implementation tier (2026-05-15 AM). |
| Deployed version | **v1.74.0** — installed via `bash install.sh --closer-context --no-confirm`; md5-parity verified on top-5 compiled files. |
| Latest release on GitHub | **v1.69.0** — local-only mode preserved per AC-CLOSER-04. |
| Branch state | `main` — local-only, NOT pushed. HEAD `d9eff13a`; ~390+ commits ahead of origin/main. |
| Codex backend | `gpt-5.4` (in `.codex/config.toml` + `pickle_settings.json`). |
| Active session | `pipeline-c543d227` (B2-RSU bundle, codex, in-flight at iter 5). |

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
# Metrics + status
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

### Latest GitHub releases
- v1.64.0 — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.64.0
- v1.63.0 — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.63.0

---

## 7. Reliability Bundle — Source PRDs Closed (session 2026-05-03-7d9ee8cc, commit 7786bcb)

- [x] prds/p1-deployed-pkgjson-version-only-revert.md
- [x] prds/p2-codex-manager-empty-queue-spin.md
- [x] prds/p3-paused-session-orphan-blocks-stop-hook.md
- [x] prds/p3-test-flakes-council-publish-and-scope-resolver.md
