---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-05-24.** Live ledger: status, open findings, queue, feature epics. Historical narrative (mega-campaign saga, per-commit detail, pre-2026-05-15 releases) lives in `MASTER_PLAN-archive.md` and git history.

## Status

| Item | Value |
|---|---|
| Version (source/deployed) | **v1.79.2** — 2026-05-24 |
| Latest GitHub release | v1.79.2 — 2026-05-24 |
| Active pipeline | none |
| Codex backend | `gpt-5.4` |

**Priority directive (operator):** drain bug bundles before feature epics. Feature epics do not count toward the open-bug ceiling.

**Dispatch order (reprioritized 2026-05-25):** **R-CSI Phase 1** forensics (operator-gated, B-CSI awaiting next sibling-session incident). Feature epics R-PGI → R-PIAP now eligible after R-MEGA-SELF-FIX v1.80.0 closes Phase 1+2. Promotions explained inline in Open Findings tables.

**2026-05-22..25 — 9 releases (v1.76.0..v1.80.0), 20 findings closed; B-FRA v1.79.0; B-APWS v1.79.1; B-WSRC-GR v1.79.2; B-CCRC v1.79.3; R-MEGA-SELF-FIX Phase 1+2 v1.80.0.** Detail in `## Recently Shipped` + `## Closed since last update`.

---

## Open Findings

Prioritized by severity × recurrence × blast radius (reprioritized 2026-05-23):
- **P1** = data-loss / silent corruption / pipeline-bricking / recurrence ≥3x
- **P2** = pipeline-friction / one-time blocker with workaround / quality gap
- **P3** = polish / documentation / niche edge cases

Each open finding: code + one-line + PRD pointer + impact rationale. Closed-finding detail in `MASTER_PLAN-archive.md`.

### P1

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 25 | R-CSI | Concurrent claude-session destructive-command interference (3 SIGINT incidents/36h) — DATA LOSS class | `p1-concurrent-claude-session-interference-with-running-pipelines.md`. Phase 1 forensics deferred per operator (await next incident). |
_(R-SJET #47 closed via R-MEGA-SELF-FIX v1.80.0 — R-SJET-3 nested-claude env isolation `c15b8332`, R-SJET-4 all_judge_backends_exhausted `710e5cfd`, R-SJET-6 integration tests `0286c356`, T-HARDEN-PROBE `65d57aab`, T-HARDEN-AUTORESUME `5a25ef7b`, T-HARDEN-DOCS `e696ce16`, env-stripping regression fix `b2936a41`. See `## Closed since last update (2026-05-25)`.)_
_(R-SSDF #46 closed via R-MEGA-SELF-FIX v1.80.0 — R-SSDF-FW AGENTS.md firewall detection + TASK_NOTES integration `82a5d453` + ignore `12373766`. See `## Closed since last update (2026-05-25)`.)_
| 28 | R-ICDM | claude iteration classifier `detectManagerMaxTurnsExit` misuse — manager loop control regression | R-ICDM-1 shipped; R-ICDM-2..7 audit. **B-R-MMTR.** |
_(R-CCRC #73 closed via B-CCRC v1.79.3 — `06d6a905` R-CCRC-1 ref-code fallback + `0e04b5ca` R-CCRC-2 done-flip guard routing. See `## Closed since last update (2026-05-24)`.)_
| 74 | R-WSWA | B-WEDGE session `pickle-e4f1269f` (2026-05-25) killed by R-WSRC-2 graceful exit `state_schema_version_ahead`. **Root cause diagnosed 2026-05-25 02:18Z**: the R-WMW-1 worker's fix REQUIRES a schema bump (LATEST_SCHEMA_VERSION 4→5 + new `worker_artifact_progress` state field + new event). Worker recompiled (`extension/services/state-manager.js` shows new normalizeV5StateDefaults), wrote a v5 state.json, but the running mux-runner (older compiled binary loaded at process start) read it and tripped R-WSRC-2. **Design gap**: schema-version-bump bundles cannot self-deploy mid-run — guard fires before the new code takes effect. Working tree preserved: 9 files modified, 5 test:fast regressions follow (same EVENT_NAMES + VALID_ACTIVITY_EVENTS drift class as R-MEGA-SELF-FIX). Operator-required: (a) fix test drift on the salvaged tree, (b) commit + install.sh + restart mux-runner BEFORE testing — fresh runner has v5 schema. Sized: ~3 tickets (test fixes + restart docs + R-WSWA event payload enrichment per original AC). |
| 75 | R-PTSB | Phantom teams-base "default-off" sessions recur (3 occurrences today: `1fa2d19e`, `4341c0f9`, `20a4c0fa`). Created during B-FRA / B-APWS / B-WEDGE runs. `original_prompt: "default-off"` or `"teams-base"` / `"effort-medium-test"` + `tmux_mode: false` + `iteration: 0` + `history: []`. Block `install.sh` until manually cancelled. Hypothesis: teams-mode worker subagent initialization writes a placeholder session via `setup.js` without then spawning tmux. Sized: ~2 tickets (root-cause + auto-cleanup heuristic). |
_(R-WSRC-GR-LEAK #76 closed via `98ea4ec0` — hook widened to match `PICKLE_ROLE === 'worker' || 'refinement-worker'` via WORKER_ROLES Set; refinement-worker variant was the leak (spawn-refinement-team.ts:92). 3 new regression tests (40/40 pass). install.sh deployed.)_
| 77 | R-PNTR-DEPS | B-PNTR R-PNTR-1 (`d586b545`) deleted `.claude/commands/pickle.md` on the premise that it was the "bare /pickle non-tmux loop" to be removed. WRONG: pickle.md is load-bearing for mux-runner prompt composition. Symptom on next dispatch: `[FATAL] pickle.md not found in /Users/gregorydickson/.claude/pickle-rick/templates or /Users/gregorydickson/.claude/commands. Run install.sh first.` Restored 2026-05-25 09:50Z via `40f22573` (file from `d586b545^` + install.sh cleanup line removed). B-PNTR scope needs re-derivation: WHAT is the actual "bare non-tmux loop" target? Likely a code path in mux-runner.ts / spawn-morty.ts, not the prompt-template file. Sized: ~1 ticket (re-scope) + revisit B-PNTR design before any further R-PNTR work. |
| 78 | R-AFCC-STALE | **auto-fill-completion-commit cross-session false attribution** surfaced 2026-05-25 16:16Z on session `pickle-a9ee4a59` (SIGINT-attribution P3): 2/3 tickets (`02de28ba`, `46ee9cef`) shipped NO new work this session (only `linear_ticket_*.md` exists — no research/plan/conformance/code_review artifacts) but `completion_commit` field was written by the auto-fill helper pointing at OLD commits from 2026-05-11 (`c0329863`, `9a19e95a`) — completely unrelated to the current session's work. R-AFCC trap door at `auto-fill-completion-commit.ts` requires reading `start_time_epoch` via `readRecoverableJsonObject(statePath)` before filtering git evidence; the filter is failing. Result: tickets falsely report Done with attribution to commits from 5 days ago. Likely root cause: ticket-id collision (R-codes or ticket-hashes from old sessions colliding with new session's tickets) OR start_time_epoch reading wrong field. Sized: ~3 tickets (audit start_time_epoch read path; add `--require-since-session-start` flag; regression test with old commit + new session fixture). |
| 80 | R-OMS | **Orphan manager subprocess survives iteration boundaries.** Observed during B-RELEASE-DRIFT pickle-ea04b6f8 2026-05-26: `claude --dangerously-skip-permissions` pid `99916` spawned by mux-runner at iter 6 boundary (2026-05-26 19:50 UTC = 2:50pm CDT) remained alive 4+ hours after iter 6 ended — through iter 7/8/9 boundaries. mux-runner spawned fresh managers per iteration (per design); the iter 6 stray was never reaped despite the iteration moving on. Risk: stray managers accumulate over long-running bundles, consume RAM (~500MB each at observed sizes), and on rare cases may compete with current manager for the same session_id / state.json locks. Hypothesis: spawn-morty/mux-runner's manager-spawn path doesn't track the spawned claude pid in state.json, so iteration-boundary cleanup has nothing to kill. Compare R-WMW (#33) which is about wedged worker subprocesses, not stray manager subprocesses. Sized: ~3 tickets (track manager pid in state.json:active_manager_pid; SIGTERM stray on iter boundary; regression test that spawns 2 sequential iters and asserts iter 1's pid is dead by iter 2 start). |
| 81 | R-AISLOW | **Auto-skip-already-Done iteration is 1h+ slow.** Observed B-RELEASE-DRIFT pickle-ea04b6f8 2026-05-26: when mux-runner picks up a ticket whose frontmatter is already `status: Done` (e.g., shipped by a prior iteration of the same session), the manager turn takes **1h25m** (`1b57ef57` 17:50:26 → 19:15:15) and **27m** (`910ae36c` similar gap) just to log `Ticket <id> already marked Done by model — skipping validation` and advance. Expected behavior: this check should be a sub-second short-circuit at iteration entry, not a full claude turn that re-derives prompt context. Hypothesis: the per-iteration claude manager session re-runs the full ticket-selection + context-build prompt even when the topmost Todo would be a no-op; the "already Done" detection lives in claude-side prompt reasoning, not mux-runner pre-check. Fix would be a mux-runner-side pre-filter that skips any ticket whose frontmatter `status` is `Done`/`Skipped` BEFORE spawning the claude manager turn. Sized: ~2 tickets (add `findFirstPendingTicket(sessionDir)` pre-check at iteration_start that skips claude spawn entirely for already-Done top tickets; regression test). Impact: cuts B-RELEASE-DRIFT-class pipeline elapsed time from ~6h to ~2h. |
| 82 | R-SJLAG | **State.json mtime lags manager turn by 25min+, blocks operator triage.** Observed B-RELEASE-DRIFT pickle-ea04b6f8 2026-05-26: state.json mtime stays frozen at the iteration-start timestamp for the entire manager-turn duration (25min+ commonly observed, 1h25m on iter 2). Operator/babysitter can't distinguish "stuck claude" from "claude making progress" via state.json alone — must drop to `tmux capture-pane` + `ls -la <ticket_dir>` to see real progress. Hypothesis: mux-runner only writes state.json at iteration boundaries (iter_start, iter_end, ticket_transition), not on artifact-write progress signals. The artifact files (research/plan/conformance) update with correct mtimes, but state.json doesn't track them. Fix would emit a `manager_turn_progress` activity event + bump state.json mtime via a touch-only write at each artifact-write detection. Sized: ~2 tickets (add periodic mtime-touch heartbeat during manager turn; document the operator-facing observability contract). Impact: cron-driven /loop babysitter can rely on `state.json` mtime as a single freshness signal instead of multi-source inference. |
| 83 | R-RIC-EXPLICIT | **Explicit `completion_commit` frontmatter field categorized as `source==='inferred'`, fataling the pipeline mid-bundle.** Observed B-RELEASE-DRIFT pickle-ea04b6f8 2026-05-26 21:55Z, ticket 110f51bd (R-SMTEST-3): on post-manager-exit validation, `hasCompletionCommit({sessionDir, ticketId: '110f51bd', workingDir})` returned `source: 'inferred'` and `guardCompletionCommitBeforeDone` raised `[fatal] cannot flip Done`, exiting mux-runner with `exit_reason: done_without_commit_evidence`. The ticket file at `<sessionDir>/110f51bd/linear_ticket_110f51bd.md` HAD an explicit `completion_commit: "6ef59f22dd25e94817b704225e80a92efe9cba31"` frontmatter line; the matching commit (`docs(110f51bd): R-SMTEST-3 — add R-SMTEST early-exit invariant docstrings to 5 spawn-morty tests`) was present at HEAD; R-CCQF (#70 — normalizeCompletionCommitField) shipped 2026-05-24 to accept both quoted and unquoted SHA forms. Yet the resolver still returned 'inferred'. **Hypothesis**: `hasCompletionCommit` does NOT read the linear_ticket_*.md file — it likely reads a different "breakdown" ticket file path under `prds/<bundle>/<ticket-dir>/ticket_<hash>.md` or via `ticketFilePath()` that may resolve differently than where the manager's explicit-frontmatter writeback lands. Operator override `state.flags.allow_inferred_completion_commit=true` (R-PDWR) unblocked the pipeline at 21:58Z. Sized: ~3 tickets (R-RIC-1 reproduce with golden-fixture ticket file at canonical `ticketFilePath()` location + assert source==='explicit'; R-RIC-2 fix the resolver path mismatch; R-RIC-3 regression test that an explicit `completion_commit:` in `linear_ticket_<id>.md` is recognized). **High severity**: this bricked an in-flight 11-ticket bundle on shipped ticket #3-of-5, with 6 follow-ons queued. Without the bypass flag, every bundle that uses linear_ticket_*.md as the canonical ticket file is one manager-kill away from this fatal. |
| 79 | B-RELEASE-DRIFT | PRD: `prds/p1-bug-fix-bundle-b-release-drift-2026-05-26.md` (12 tickets across 5 classes). **v1.80.2 release gate exposed 12 pre-existing test failures** during the 2026-05-26 release-prep attempt. 6 closed in-flight (R-POD `&&` predicate test drift in matrix/paused-orphan/activity-logger fixtures + missing R-MDS-4 monitor-mode-transition ENFORCE test). 12 remain across 5 classes: **(a) spawn-morty fast-fail (5)** — `spawn-morty: valid args but no claude binary`, `--output-format as last arg`, `--review flag accepted`, `--ticket-file with --prefix value`, `--timeout with custom value` all hit the 45 000 ms test timeout with `result.status === null`; spawn-morty no longer ENOENTs immediately when PATH lacks `claude`. **(b) mux-runner quality-gate skip (2)** — `legacy fallback warns once per process` + `skip_readiness_reason does NOT bypass ticket_audit_gate` cross-test process-shared-state pollution. **(c) mux-runner ticket-audit-halt (2)** — `halt error names state.flags.skip_ticket_audit_reason` (60s) + `audit-bundle-halt halts before manager spawn` (150s) slow + assertion drift. **(d) ensureMonitorWindow mock drift (2)** — `respawns dead monitor and watcher panes with injected spawn capture` + `stale EXTENSION_DIR falls back before watcher pane respawn`. **(e) resolveStateFile isolation (1)** — `mapped pid=null orphan with dead mapped PID falls back to the live active state` passes in isolation, fails in full suite. v1.80.2 bump committed (`47881dbc`) then reverted (`02495054`) — release blocked until B-RELEASE-DRIFT ships. Sized: ~12 tickets (one per failing test, grouped by root-cause class). |

### P2

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 30 | R-RSU | refinement collapses `composes:` bundle PRDs to N section-umbrellas | R-RSU-1..5; B2-RSU residuals. **B-QSRC / B-WEDGE.** |
| 33 | R-WMW | manager wedges on oversized ticket; spawns worker, no artifact progress | `p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md`. **B-WEDGE.** |
| 34 | R-WTB | `Defaults.WORKER_TIMEOUT_SECONDS: 1200` too short for R-PTG worker lifecycle | R-WTB-1..4; B2-RSU residual. **B-QSRC. (Promoted P3→P2 2026-05-23: blocks R-PTG worker lifecycle; tier_cap_override workaround needed each session.)** |
| 39 | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool check | PRD not drafted (~4 tickets). **B-GATE.** |
| 40 | R-VSGE | verification commands with shell-special chars error under zsh glob expansion | PRD not drafted (~4 tickets). **B-GATE.** |

### P3

| # | Code | Summary | PRD / Status |
|---|---|---|---|
_(#5 B-AUDIT CLOSED 2026-05-26 — all 5 subsystems (`bin/`/`hooks/`/`lib/`/`services/`/`types/`) now report **OK** under `scripts/audit-subsystem-claude-md.sh`. Final tickets: `bb7d040e` hooks (6c8c29b2), `1a64117e` types (3255afb2). See `## Closed since last update (2026-05-26)`.)_
| 12 | R-PSAI | `/pickle-pipeline` ignores branch/subset signals in operator kickoff | `p2-pickle-pipeline-no-scope-auto-inference.md`. **(Demoted P2→P3 2026-05-23: UX friction; operator can pass `--scope` explicitly.)** |
| 19 | R-MMTR | claude manager max-turns family closeout pending | R-MMTR-1/5 shipped; 2/3/4 Skipped+commit; 6 force-skipped; 7 closer pending. **B-R-MMTR / B-E2E.** |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | R-MWCL-1 shipped; 3..7 residual. **B-MONITOR.** |
| 32 | R-TFP | `test:fast` + `test:integration` parallel-load flakes | `p2-test-fast-stability-gate-widening-2026-05-19.md`. v1.76.0 serialized the subprocess-heavy tail via `.serial-tests.json` and retiered `council-publish` / `mux-runner.output-stall` / `check-update` fast→integration — gate verified green. B-FLAKE SHIPPED; watch item only. |
| 37e | R-PIWG-5 | git-isolation residual: `lsof` launch-time concurrent-access probe | **B-LSOF** (~2-3 tickets). |

### Closed since last update (2026-05-22)
- #58-#63 — **B-BABYSIT-FIX** (`bf89a1a3`) + **R-CCR** review-hardening (`e448b714`), v1.76.0.
- #64 R-RHFP — readiness `performance` findings demoted to advisory; telemetry-event literals skipped (`a0604987`).
- #65 R-RCEX — `resolveSymbolRef` resolves external SDK symbols against `node_modules/*.d.ts` (`8cb5ba79`).
- #50 R-SRGT — `computeOneHop` empty-seed short-circuit + 60s wall cap; per-grep 30s→5s (`6f71dd6a`).
- #57 R-RPRA — verified: R-RHFP PATH_RE negative lookbehind prevents leading-`/` phantom finding. R-FRA facets remain.
- #49 R-PSSS — empty-scope skips emit WARN + `*_empty_scope_skip` events; `PhaseSetupResult` + `phase_skips` (`988ed55a`,`9020c26b`). B-PIPE-LAUNCH-FRICTION fully shipped v1.77.0.
- #51 R-PPSD — verified: both pipeline skill prompts document `skip_quality_gates_reason`. No code change.
- #18 R-FGNC — `convergence-gate:buildFailures` combines stdout+stderr, strips `.npmrc` WARN; szechuan runs lint-autofix pre-commit (`48718c63`,`b5500da8`). R-FGNC-6 (R-MAY) deferred.

### Closed since last update (2026-05-23)
- #48 R-PCFG — verified: R-PIPE-2 `phase_no_progress` gate (`bd5e4466`, 14 tests) catches false "completed successfully" after non-zero exit.
- #54 R-MRFP — verified: `detectMultiRepo` dedupes by enclosing git repo root (`5501d4ed`, 8 monorepo tests).
- #53 R-SRAA — `writeScopeArchive` rotates pre-existing archive to `.bak`; `SCOPE_ARCHIVE_EXISTS` retired (`19ff0dd1`).
- #5 B-AUDIT (partial) — `hooks/`+`lib/` flipped INCOMPLETE→OK; `types/` cleared STALE; `bin/`+`services/` still INCOMPLETE (`1add4451`).
- #32 R-TFP gate-blocking — **B-FLAKE** serialized flake-tail shipped v1.76.0; retained as P3 watch item.
- **B-FRA/B-APWS bundle PRDs drafted** — `cfa38603`,`46db2c27`. Ready for dispatch in priority order.
- #52 R-WUWC — **B-WUWC-REPRODUCER CLOSED**: wuwc-reproducer.test.js confirms all 4 prevention layers green (R-WSE-1/2/3 + R-PIPE-2). Reproducer: `d9bdb589`; trap-door: `4b38893c`; closer: 26301c6a (v1.78.2). Test: `extension/tests/wuwc-reproducer.test.js`.

### Closed since last update (2026-05-24)
- #66 R-FRA — readiness gate false-positives on forward-created test/script files: **B-FRA CLOSED** (R-FRA-6 shared predicate, R-FRA-2 pre-flight script, R-FRA-3 persona Step 0, R-FRA-4 prds/CLAUDE.md). v1.79.0.
- #67 R-RTRC8 — `/pickle-refine-prd` Step 7c missing forward-ref annotation reminder: **B-FRA CLOSED** (R-FRA-1). v1.79.0.
- #70 R-CCQF — `hasCompletionCommit` now accepts unquoted-short / unquoted-full / quoted-short / quoted-full SHA via new `normalizeCompletionCommitField` helper (`e3f510fd`). 12 regression assertions in `extension/tests/has-completion-commit-quoted-form.test.js`. Trap-door pinned in `extension/CLAUDE.md`.
- #71 R-PEDC — `mux-runner.clearStaleDoneWithoutCommitEvidence` clears stale `done_without_commit_evidence` exit_reason on 4 `guard.ok===true` recovery paths (`e3f510fd`); mirrors R-CCR-3 stale-handoff pattern. 5 regression assertions in `extension/tests/exit-reason-clears-on-recovery.test.js`.
- #68 R-FRA-GATE — forward-ref annotation regex parity drift between `check-readiness` and `audit-ticket-bundle`: **B-FRA CLOSED** (R-FRA-6 unified FORWARD_REF_ANNOTATION_RE module imported by both consumers). v1.79.0.
- #69 R-FRA 5th recurrence — `B-PROJECT-AUDIT-2026-05-23` hit READINESS HALT on 34 forward-created findings: **B-FRA CLOSED**. PRD: `prds/p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md`. v1.79.0.
- #11 R-APWS — scope-allowlist enforcement regression coverage + observability test landed; preflight, event, and status-drift rendering now end-to-end-tested. Worker-simulation tests for anatomy-park (`69aaa442`) + szechuan-sauce (`45223a06`), renderScopeDrift output-contract test (`e80eaed5`), worker-prompt ordering trap-door (`2aa079c2`). **B-APWS CLOSED.** Bundle ships under v1.79.1.
- #72 R-WSRC-GR — `config-protection.ts` blocks 9 prohibited git verbs from worker subprocesses; trap-door pinned in `extension/CLAUDE.md`; Git Boundary Rules prompts augmented with runtime-enforcement note. **B-WSRC-GR CLOSED.** closer: `b60d4cfb` (v1.79.2).

### Closed since last update (2026-05-25)
- #27 R-MMRT — monitor respawn now validates `sessionDir` at every entry (`restartDeadWatcherPanes`, `respawnMonitorWindowForMode`, `startRespawnWatchdog`) before any tmux send-keys / respawn-pane; invalid sessionDir produces zero spawns + one deduped `monitor_respawn_session_dir_invalid` event per (caller, sessionDir, reason) tuple. **B-MONITOR CLOSED.** R-MMRT-1+R-MMRT-3 `65bf6bd3`, R-MMRT-2 `d1e5f886`, R-MMRT-5 integration cascade test `d0ff0a85`, R-MMRT-4 trap-door pin `6e187f67`. v1.80.1.

### Closed since last update (2026-05-26)
- #5 B-AUDIT — subsystem CLAUDE.md drift fully closed. All 5 subsystems (`bin/`/`hooks/`/`lib/`/`services/`/`types/`) report **OK** under `scripts/audit-subsystem-claude-md.sh`. `hooks/` Public Exports + Handler Invariants ticket `6c8c29b2` → `bb7d040e` (R-WSRC-GR salvage via path-scoped restore). `types/` Public Exports + Handler Invariants ticket `3255afb2` → `1a64117e`. Audit script: 5/5 OK.
- **Stale-PRD sweep** — drain audit found 7 P3 PRDs whose work has been shipped under other bundles but `status: Draft` was never updated: `p3-readiness-resolver-tilde-path-stripping.md` (R-RTPS-1 trap door + `check-readiness-tilde-paths.test.js` shipped), `p3-collapse-quality-gate-skip-flags.md` (R-QGSK-3 unified flag + auto-migration), `p3-paused-session-orphan-blocks-stop-hook.md` (state-manager R-POD trap door + 4 regression tests), `p3-state-manager-paused-orphan-demotion-or-aggression.md` (R-POD `&&` predicate trap door), `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` (R-PDT-1..4 via `1e821336` — `DIRTY_ALLOWED_FILE_REL` + `ac-dr-02.runtime.json` separation), `p3-monitor-watcher-continuous-auto-respawn.md` (R-MWR-1..6 trap doors + `monitor-watchdog.test.js`), `p3-pipeline-runner-sigint-no-origin-attribution.md` (R-SOA-5 trap door + `pipeline-runner-signal-attribution.test.js`). Operator-level cleanup: mark these PRD `status:` fields `Shipped` in a future pass — no code change needed.

Earlier closed (detail in archive): #1-#4 (incl. R-CCPL reopened-P1 closed 2026-05-15 by R-CCPM-1..5 — `f915b821`/`690e5c5c`/`e955ce4d`/`39a660e4`/`73657d27`), #6, #8-#10, #13-#17, #20-#24, #26, #31, #36-#38, #41-#45 R-WSRC/R-MRWG/R-CTSF/R-CCPM-1b.

---

## Active Queue — bug bundles first

≤14 tickets/bundle. Status: NEXT · IN-FLIGHT · QUEUED · DEFERRED · SHIPPED. NEXT bundles listed in dispatch order (reordered 2026-05-24).

### P1 bundles — dispatch order

| # | Bundle | Status | Composes | Notes |
|---|---|---|---|---|
| 1 | **B-FRA** | SHIPPED | #66 + #67 + #68 + #69 | **CLOSED** — bundle PRD `p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md` (cfa38603). R-FRA-1..R-FRA-6 tickets all Done. Closes #66+#67+#68+#69. Trap doors: R-RTRC-1..7 (prior) + R-FRA-1, R-FRA-2, R-FRA-6 (new). v1.79.0. |
| 2 | **B-APWS** | SHIPPED | #11 R-APWS | **CLOSED** — bundle PRD `p1-bug-fix-bundle-b-apws-scope-allowlist-enforcement-2026-05-23.md` (46db2c27). 5 tickets R-APWS-7..11. Regression coverage + observability test. Trap doors: R-APWS-7..10 scope-preflight wiring + renderScopeDrift output contract. Every worker fired R-WSRC-GR (4x) — all self-recovered via path-scoped `git restore --source`. v1.79.1. |
| 3 | **R-MEGA-SELF-FIX** | PARTIAL | B-PIPE-FIX + B-SJET-2 + B-SSDF + launch-friction + R-CSI | `p1-self-fix-mega-campaign-2026-05-19.md`. Phase 0 done; Phase 3 shipped v1.77.0. Phase 1 (#47 judge env isolation), Phase 2 (#46 AGENTS.md firewall) — szechuan PHASE BLOCKERS. Phase 4 (#25 R-CSI forensics) DEFERRED in B-CSI. |
| 4 | **B-WUWC-REPRODUCER** | SHIPPED | #52 R-WUWC | **CLOSED** — bundle PRD `p1-bug-fix-bundle-b-wuwc-reproducer-2026-05-23.md` (92bed106). All 4 prevention layers confirmed green by wuwc-reproducer.test.js (`d9bdb589`). Closer: 26301c6a (v1.78.2). Auto-commit salvage (Bug 5 fix #2) still not shipped → follow-up R-WUWC-2-SALVAGE if filed. |
| 5 | **B-QSRC** | QUEUED | R-QGSK + R-RSU residuals from B2-RSU partial-ship | New bundle PRD needs scoping. Closes residue of #29/#30/#34. |
| 6 | **B-CSI** | DEFERRED | R-CSI Phase 1+2 | Await next sibling-session incident before scoping Phase 2. Operator-gated. |
| 7 | **B-CCDC** | DEFERRED | R-CCDC citadel detection-coverage successor | Per operator: maybe-later. |
| — | **R-CCR** | SHIPPED | B-BABYSIT-FIX review hardening | 16/16, 4/4 phases, `e448b714`; shipped under the v1.76.0 tag 2026-05-22. |
| — | **B-BABYSIT-FIX** | SHIPPED | findings #58-#64 | `bf89a1a3`. R-CCR hardens the review residue. |

### P2 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-GATE** | PARTIAL | R-FGNC + R-PVTA + R-VSGE | **R-FGNC (#18) shipped 2026-05-22** (`48718c63`+`b5500da8`). R-PVTA (#39) / R-VSGE (#40) still need PRDs drafted. Verify-command host-tool gaps cause silent worker failures. |
| **B-WEDGE** | QUEUED | R-RSU residuals + R-WMW | Closes #30/#33. Manager wedge on oversized ticket is visible (no data loss) but burns wall-time. |
| **B-MONITOR** | QUEUED | R-MMRT + R-MWCL residuals | Closes #27/#29. Observability gap; cosmetic + diagnostic impact. |
| **B-PNTR** | QUEUED | remove bare `/pickle` non-tmux loop | `p2-remove-non-tmux-pickle-loop.md`. Refinement recommended pre-launch. |
| **B-FLAKE** | SHIPPED | R-TFP-W | `test:fast` + `test:integration` green; flake tail serialized via `.serial-tests.json`. Shipped in v1.76.0. |
| **B-PIPE-LAUNCH-FRICTION** | SHIPPED | R-PSSS + R-SRGT + R-PPSD | `p2-pipeline-launch-friction-bundle-2026-05-18.md`. All three findings closed 2026-05-22 (#49/#50/#51) — shipped under the **v1.77.0** tag. |

### P3 bundles

| Bundle | Status | Composes | Notes |
|---|---|---|---|
| **B-R-MMTR** | QUEUED | R-ICDM-2..7 + R-MMTRH heal + R-MMTR-7 closer | Closes #19/#28. |
| **B-E2E** | QUEUED | R-MMTR6S | E2E re-attempt of force-skipped R-MMTR-6. Ships after B-R-MMTR. |
| **B-LSOF** | QUEUED | R-PIWG-5 | `lsof` concurrent-git-process probe (~2-3 tickets). |
| **B-AUDIT** | SHIPPED | subsystem CLAUDE.md drift (#5) | All 5 subsystems OK (closer `1a64117e` 2026-05-26). `hooks/` + `lib/` → OK; `types/` cleared STALE; `bin/`/`services/`/`types/` still INCOMPLETE under `audit-subsystem-claude-md.sh`. Per-export documentation, ongoing. |

---

## Feature Epics — after the bug drain

Gated behind operator's drain-bug-bundles-first directive. Do not count toward open-bug ceiling.

| Epic | Priority | PRD | Scope |
|---|---|---|---|
| **R-PIAP** | P2 | `p2-proportional-intent-aware-pipeline-2026-05-21.md` | Proportional + intent-aware processing. Pillar A: tier-proportional lifecycle + auto-sizing classifier. Pillar B: anatomy/szechuan auto-detect UI-primary branches. 11 reqs. |
| **R-PGI** | P2 | `p2-pipeline-graph-intelligence-2026-05-21.md` | GitNexus embedding. Graph-preflight stage + staged consumption (direct `.gitnexus/` target, MCP fallback). 9 reqs. Feeds R-PIAP-A5 classifier. |

**Order when bug queue allows:** R-PGI first (infrastructure R-PIAP-A5 consumes), then R-PIAP.

### Deferred future epics

- **Integrations:** `hermes-integration.md` (P2 ready), `deepseek-integration.md` (P3 draft), `openrouter-multi-provider-workers.md` (P3)
- **Refactor:** `god-functions-remediation-phase-2.md` (27 carve-outs)
- **Methodology PRDs:** `portal-gun.md`, `pickle-debate.md`, `pickle-microverse.md`
- **Design docs (no ship target):** `citadel.md`, `pickle-dot-codegen-builder.md`, `council-of-ricks-catalog-mode-and-publish-fixes.md`, `plumbus-generative-audit-frames.md`, `pickle-agent-teams.md`, `smart-iteration-handoff.md`, `tool-error-retry-tracking.md`

---

## Recently Shipped

| Release | Date | Content |
|---|---|---|
| v1.79.0 | 2026-05-24 | **#66+#67+#68+#69 B-FRA CLOSED** — forward-ref annotation bundle: R-FRA-6 (shared FORWARD_REF_ANNOTATION_RE), R-FRA-2 (pre-flight audit-ticket-forward-refs.sh), R-FRA-1 (Step 7c reminder), R-FRA-3 (persona Step 0 heuristic), R-FRA-4 (prds/CLAUDE.md authoring guide). 3 new trap doors: R-FRA-1, R-FRA-2, R-FRA-6. PRD: `prds/p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md`. |
| v1.78.2 | 2026-05-23 | #52 R-WUWC **CLOSED** — B-WUWC-REPRODUCER: wuwc-reproducer.test.js confirms all 4 prevention layers (R-WSE-1/2/3 + R-PIPE-2). Reproducer (`d9bdb589`) + trap-door (`4b38893c`) + closer 26301c6a. |
| v1.78.1 | 2026-05-23 | #53 R-SRAA (`scope-resolver:writeScopeArchive` rotates to `.bak`; `SCOPE_ARCHIVE_EXISTS` retired) + #48 R-PCFG + #54 R-MRFP verified + #5 B-AUDIT partial (`hooks/`+`lib/`→OK). |
| v1.78.0 | 2026-05-22 | #18 R-FGNC — `convergence-gate:buildFailures` combines stdout+stderr, strips `.npmrc` WARN; finalize-gate summarises by check; szechuan runs lint-autofix pre-commit. Also serialized `dispatch.test.js` (R-TFP). |
| v1.77.0 | 2026-05-22 | Readiness/scope false-positive cluster + B-PIPE-LAUNCH-FRICTION. #64 R-RHFP / #65 R-RCEX / #57 R-RPRA (check-readiness), #50 R-SRGT (scope-resolver caps), #51 R-PPSD (skill docs), #49 R-PSSS (empty-scope WARN + events). |
| v1.76.0 | 2026-05-22 | Release-gate stabilization. R-CCR review-hardening (16/16). 1 real regression + 6 stale-test repairs; flake-tail serialized via `.serial-tests.json`; 3 subprocess-timeout files retiered fast→integration. |
| v1.75.0..v1.75.5 | 2026-05-16..17 | B-WSRC (#43), B-MRWG (#42), B-CTSF (#44), B-CCPM-1b (#45), B-SJET partial (#47 open), surgical sweep F1-F3+F5 (#2). |
| v1.73.0..v1.74.0 | 2026-05-09..11 | v1.73.0 11-section mega bundle (closes #11-13, #16); v1.74.0 reliability mega + R-MMTR + R-ARSF auto-resume. |

Pre-v1.73.0 + per-release v1.75.x detail in `MASTER_PLAN-archive.md` + git log.

---

## Engineering Rules

Detail in `extension/CLAUDE.md` + `prds/citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR, independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`. Clean before tag.
3. **Source-of-truth** — edit `extension/src/*.ts` + `.claude/commands/*.md`; `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every `extension/CLAUDE.md` invariant has an enforcing test.
5. **Hook decisions** — `"approve"` / `"block"` only.
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries.
8. **Versioning** — semver in `extension/package.json`; single bump per epic at the closer.
9. **No dirty release** — all changes committed before tag; compiled JS matches TS source.
10. **Greenfield** — no legacy aliases, no backward-compat shims.

---

## Quick Reference

```bash
/pickle-status                       # formatted current session
/pickle-metrics                      # token/commit/LOC report
/pickle-prd                          # interview then PRD
/pickle-refine-prd <prd>             # 3-cycle decomposition
/pickle-tmux <prd>                   # 3+ tickets
/pickle <prd>                        # 1-2 tickets, interactive
/pickle-pipeline <prd>               # pickle, citadel, anatomy-park, szechuan-sauce
gh release create vX.Y.Z             # tag + publish
```

**Resume an active loop:** `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
Closer manager handoff runbook: `docs/closer-ticket-manager-handoff.md`.
