---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-05-29.** Live ledger: status, open findings, queue, feature epics. Historical narrative (mega-campaign saga, per-commit detail, pre-2026-05-15 releases) lives in `MASTER_PLAN-archive.md` and git history.

## Status

| Item | Value |
|---|---|
| Version (source/deployed) | **v1.85.0** — 2026-05-30 (R-DC feature epic shipped; deployed + tagged) |
| Latest GitHub release | v1.85.0 — 2026-05-30 (v1.81.1..v1.85.0 all tagged; R-PGI+R-PIAP+R-DC feature epics shipped — dispatch order drained) |
| Active pipeline | R-PIAP (launching) |
| Codex backend | `gpt-5.4` |

**Priority directive (operator):** drain bug bundles before feature epics. Feature epics do not count toward the open-bug ceiling.

**Dispatch order (updated 2026-05-29 after B-PIPE-HARDEN-2 + B-AFCC-DEEP shipped):**
1. ~~**B-PIPE-HARDEN-2**~~ — **SHIPPED v1.81.1** (2026-05-28). Closer `c7feae53` landed via `6dc6a987` (release-gate parity fixture + lockfile) + `2052107b` (closer residuals — parity test / audit-logger / tier promotion drift). Session `pickle-dfb58722`.
2. ~~**B-AFCC-DEEP**~~ — **SHIPPED v1.82.0** (2026-05-29). 12/12 tickets landed in session `pickle-a9e25752` (commits `ab432842`..`0e64a705`). Closer ran full release gate green + bumped to v1.82.0 + masked-failure remediation. PRD `p1-bug-fix-bundle-b-afcc-deep-autofill-done-flip-cluster-2026-05-28.md`. Bundle eliminated the 30-day autofill / Done-flip cluster: created `TicketCompletionEvidence` module with 5 entry points (5 callsites migrated), collapsed `auto-fill-completion-commit` + `inspectPhantomDoneTicketFile` + `correctPhantomDoneTickets` into thin shims, pushed `git cat-file -e` reachability into `hasCompletionCommit`, pinned 3 new trap doors + R-AFCC-DEEP-CONSOLIDATED master pin, added 8-path characterization suite + R-CLOSER-ADJACENCY-AUDIT 6-step template.
3. ~~**B-CWRR**~~ — **SHIPPED v1.82.1** (2026-05-29). Citadel monorepo workingDir doubling (#88) closed in session `2026-05-29-58a9de87` (commits `cd139d23`..`10b787c9`). F3 fix: `PipelineRuntime.repoRoot` distinct from `workingDir`, computed once via `git rev-parse --show-toplevel` (fallback to `workingDir` on non-repo); `executeCitadelPhase` repointed; 5 toplevel-intent call sites converted + remaining `workingDir` uses annotated; Class C pipeline-status fatal-exit counter accuracy; regression spec `citadel-reporoot-monorepo.test.js`. Closer `10b787c9` (full release gate green + PATCH bump). PRD `p1-bug-fix-bundle-b-cwrr-citadel-workingdir-as-reporoot-2026-05-29.md`.
4. **R-CSI Phase 1** forensics (operator-gated, B-CSI awaiting next sibling-session incident).
5. Feature epics: ~~**R-PGI**~~ **SHIPPED v1.83.0** (2026-05-29, session `pickle-53ace8c2`, 5 tickets commits `cd139d23`..`0f60b485` + bump; full release gate green, test:fast c=8 flakes confirmed isolation-clean at c=1; babysitter also fixed  false-positive `8af9aa07`). ~~**R-PIAP**~~ **SHIPPED v1.84.0** (session `pickle-88a98a05`, 11 tickets, full gate green; test:fast c=8 flakes confirmed isolation-clean at c=1). ~~**R-DC**~~ **SHIPPED v1.85.0** (2026-05-30, session `pickle-a29d8404`, 8 tickets R-DC-1A..1H; `/death-crystal` skill + 4 design-Morty agents + HTML report renderer + Architectural Vocabulary pin; closer bumped v1.85.0 `d9e3113f`+`7029eddf`; deterministic orphan-reset self-recovered via ff-reattach each ticket; terminal exit_reason='error' cosmetic — graph-preflight between-ticket flake at teardown, all work shipped+tagged). **Dispatch order DRAINED** — all feature epics shipped; remaining bug bundles (B-QSRC/B-WEDGE/B-MONITOR/B-PNTR/B-GATE) need PRDs scoped; #25 R-CSI operator-gated.

Promotions explained inline in Open Findings tables.

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
| 78 | R-AFCC-STALE | **auto-fill-completion-commit cross-session false attribution** surfaced 2026-05-25 16:16Z on session `pickle-a9ee4a59`. `completion_commit` written by autofill pointing at OLD commits from 2026-05-11 (`c0329863`, `9a19e95a`) — unrelated to current session work. **2026-05-28 RECLASSIFIED**: now subsumed by **B-AFCC-DEEP** RCA bundle. Original sizing (~3 narrow tickets fixing `start_time_epoch` filter) superseded by the broader simplification verdict — Agent C's analysis showed the helper itself is dead-code racing `inspectPhantomDoneTicketFile`. The stale-attribution surface vanishes when the helper is deleted (B-AFCC-DEEP Phase 3A) and the remaining oracle returns first-class `kind: 'inferred-stale'` (Phase 3C+4A). See PRD `p1-bug-fix-bundle-b-afcc-deep-autofill-done-flip-cluster-2026-05-28.md`. |
_(R-OMS #80 CLOSED via B-PIPE-BABYSIT-HARDEN v1.81.0 — orphan-manager reaping via sidecar `.active_manager.pid` + ps-scan at iteration_start; emits `orphan_manager_reaped`; schema-neutral (no LATEST_SCHEMA_VERSION bump, dodges #74 R-WSWA). `ed13a2a5` (operator-salvaged after worker timed out post-implement, tsc+15/15 tests validated). See `## Closed since last update (2026-05-27)`.)_
_(R-AISLOW #81 CLOSED via B-PIPE-BABYSIT-HARDEN v1.81.0 — `findFirstPendingTicket` iteration-start pre-skip; already-Done top ticket advances without a claude manager turn. `a03b1766`. Highest-leverage: cuts already-Done iteration from ~1h to sub-second. See `## Closed since last update (2026-05-27)`.)_
_(R-SJLAG #82 CLOSED via B-PIPE-BABYSIT-HARDEN v1.81.0 — manager-turn freshness heartbeat bumps state.json mtime + emits `manager_turn_progress` on artifact-write; mtime/activity-only (R-WSRC-safe). `24cb85d0` + `94cb35c0` (monotonic-mtime fix). Babysitter can now use state.json mtime as a single freshness signal. See `## Closed since last update (2026-05-27)`.)_
| 86 | R-CMWL | **Codex manager exits pickle phase at a fixed ~60-min wall; `pipeline-runner` treats clean-but-incomplete pickle as fatal (`phase_incomplete_tickets`), stranding the bundle.** Observed attractor-v11 build `pickle-591247f9` 2026-05-27: each codex pickle pass runs ~60m (`mux-runner finished. 31 iterations, 60m 15s`), completes ~3 tickets, exits `Session inactive`, then `Pipeline finished: 0/4 phases` — a 40-ticket bundle needs ~13 operator relaunches. `--max-time 0` does NOT lift it, so the 60-min wall lives below session max-time. claude backend already relaunches at its 400-turn boundary (R-MMTR-3 / `CLAUDE_MANAGER_RELAUNCH_CAP=20`); codex path either misclassifies the exit as non-relaunchable (cf. R-ICDM #28) or is overridden by pipeline-runner's incomplete-fatal verdict (H1/H2/H3 in PRD). Want: turn/progress-based relaunch (not a fixed wall) + stop treating progressing-but-incomplete pickle as fatal + no-progress guard. Second-order: 60-min cutoff leaves interrupted-ticket work uncommitted → trips `assertCleanWorkingTree` on relaunch. Operator band-aid in place: external `auto-relaunch.sh` (stash+reset+relaunch, 2-pass no-progress guard). Sized: ~4 tickets. `BUG-REPORT-2026-05-27-codex-manager-fixed-wall-pickle-stall.md`. **B-PIPE-BABYSIT-HARDEN.** |
_(R-RIC-EXPLICIT #83 CLOSED via B-RIC-EXPLICIT v1.80.3 — `hasCompletionCommit` now honors explicit `completion_commit:` frontmatter in `linear_ticket_<id>.md`. R-RIC-EXPLICIT-1 red test `3255dec5`, R-RIC-EXPLICIT-2 fix (decouple gitCommitExists from explicit-frontmatter branch) `6efc4e53`, R-RIC-EXPLICIT-4 phantom-revert watcher reachability (gate-caught regression) `103ef20b`, bump+trap-door `863016bb`. Tag `b451e657`. See `## Closed since last update (2026-05-27)`.)_
_(B-RELEASE-DRIFT #79 CLOSED v1.80.2 — all 5 root-cause classes resolved (R-SMTEST spawn-morty fast-fail ×5, R-MUXQG quality-gate skip ×2, R-MUXAUDIT ticket-audit-halt, R-EMWMOCK monitor mock drift, R-RSFISO resolveStateFile isolation) + 2 in-flight drift discoveries (R-SMTEST-6 `827c6641`, R-RELDRIFT-2 `b2c286a2`). 13 tickets total. See `## Closed since last update (2026-05-27)`.)_

### P2

| # | Code | Summary | PRD / Status |
|---|---|---|---|
| 30 | R-RSU | refinement collapses `composes:` bundle PRDs to N section-umbrellas | R-RSU-1..5; B2-RSU residuals. **B-QSRC / B-WEDGE.** |
| 33 | R-WMW | manager wedges on oversized ticket; spawns worker, no artifact progress | `p2-worker-manager-wedge-oversized-ticket-no-artifact-progress.md`. **B-WEDGE.** |
| 34 | R-WTB | `Defaults.WORKER_TIMEOUT_SECONDS: 1200` too short for R-PTG worker lifecycle | R-WTB-1..4; B2-RSU residual. **B-QSRC. (Promoted P3→P2 2026-05-23: blocks R-PTG worker lifecycle; tier_cap_override workaround needed each session.)** **B-PIPE-HARDEN-2** (Class A) — observed 2026-05-27 B-PIPE b04f41d6 implement-phase halt; operator salvaged + bumped to 3600s for the rest of the run. |
| 39 | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool check | PRD not drafted (~4 tickets). **B-GATE.** |
| 40 | R-VSGE | verification commands with shell-special chars error under zsh glob expansion | PRD not drafted (~4 tickets). **B-GATE.** |
| 84 | R-ACSG | **AC-shape collapse-or-justify gate oscillates, false-rejects properly-consolidated analyst tickets.** Filed 2026-05-27 from LOA-727 post-review-hardening incident (session `2026-05-27-aeb6ec52`). 3 refinement attempts, ~30 min wall, ~9 worker quotas burned reshaping a PRD whose analyst-emitted tickets were already correctly consolidated. Smell count INCREASED 2→9 across attempts (oscillation, no monotonicity). Attempt 2's manifest had `justification_present: true` on every ticket + universal-quantifier titles + `describe.each` syntax — gate still rejected. Workarounds: aggressive table-driven PRD reshape, or `--no-refine` (neither obvious to new users). Four competing root-cause hypotheses preserved in PRD as decision tree (H1 matcher-too-literal, H2 cycle-3-oscillation, H3 PRD/ticket-conflation, H4 convergence-cost). PRD: `prds/BUG-REPORT-2026-05-27-refine-prd-ac-shape-gate-oscillation.md`. Possibly related to #30 R-RSU (inverse: over-collapse vs under-acceptance) — check shared matcher. Sized: ~3-8 tickets depending on hypothesis dominance (narrow fix = matcher; wide fix = refinement convergence arch). |
| 85 | R-PPCD | **`/pickle-pipeline` skill prompt + `persona.md` routing both omit citadel and assert a false phase list.** Filed 2026-05-27. `pipeline-runner.ts:187-197` (`normalizePipelinePhases`) unconditionally splices `citadel` in after `pickle` (when pickle precedes anatomy-park), and the runner's own header comment (lines 6-10) documents the real **4-phase** order: pickle → citadel → anatomy-park → szechuan-sauce. But the docs were never updated when citadel became a native phase: (a) `.claude/commands/pickle-pipeline.md` mentions citadel **zero** times — line 1 header, line 13 "the runtime orchestrator (`pipeline-runner.js`) only runs build → anatomy-park → szechuan-sauce" (FALSE), line 51 phase list, line 197 default array `["pickle","anatomy-park","szechuan-sauce"]`, line 204 template all omit it; (b) `persona.md:19` (deployed to `~/.claude/CLAUDE.md`) repeats the same false "only runs build → anatomy-park → szechuan-sauce" claim in the routing section the assistant reads every session. Runtime still works (splice auto-injects citadel even when the default array omits it), so this is doc-only drift — but it actively misled operator planning (citadel was wrongly scoped as a manual post-step). Fix scope (~1-2 tickets, doc-only): update pickle-pipeline.md (header, line-13 claim, Step 4 default phases array + template, Step 8 report template) to show citadel as phase 2/4; fix `persona.md:19` routing line (edit source per [[feedback_persona_source_of_truth]], never `~/.claude/CLAUDE.md` directly); `bash install.sh` to redeploy both. Note: persona.md edit is config-protected. |
| 87 | R-CSIS | **Closer-ticket manager runs expensive soak tests standalone via `node --test`, bypassing the documented gate's self-skip and triggering an infinite per-ticket-timeout loop.** Filed 2026-05-28 from B-PIPE-BABYSIT-HARDEN closer e7c52000 incident (session `pickle-f91100e6`). The closer's gate-runner spawned `node --test tests/integration/deploy-lifecycle-soak.test.js` directly instead of the documented `RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. When run via the npm script the soak skips fast (no `CI=true`, "refuses to mutate $HOME") — when run standalone it executes the full `SOAK_SECONDS ?? 1800` (30-min minimum, enforced via `throw if < 1800`). With the per-ticket worker timeout at 3600s and manager turn already ~44min in, the soak guaranteed a timeout-halt → relaunch → re-soak loop. Operator took the closer over manually (kill manager+soak+mux-runner, run standard gate where soak skips, do version bump + install.sh, halt for push). Sized: ~2 tickets (closer gate-runner must invoke documented `npm run test:expensive` command never an individual expensive-tier test file standalone; regression test that the closer's gate command set matches CLAUDE.md release-gate spec exactly). Possibly bundle with #34 R-WTB + #32 R-TFP as B-PIPE-HARDEN-2. |

### P3

| # | Code | Summary | PRD / Status |
|---|---|---|---|
_(#5 B-AUDIT CLOSED 2026-05-26 — all 5 subsystems (`bin/`/`hooks/`/`lib/`/`services/`/`types/`) now report **OK** under `scripts/audit-subsystem-claude-md.sh`. Final tickets: `bb7d040e` hooks (6c8c29b2), `1a64117e` types (3255afb2). See `## Closed since last update (2026-05-26)`.)_
| 12 | R-PSAI | `/pickle-pipeline` ignores branch/subset signals in operator kickoff | `p2-pickle-pipeline-no-scope-auto-inference.md`. **(Demoted P2→P3 2026-05-23: UX friction; operator can pass `--scope` explicitly.)** |
| 19 | R-MMTR | claude manager max-turns family closeout pending | R-MMTR-1/5 shipped; 2/3/4 Skipped+commit; 6 force-skipped; 7 closer pending. **B-R-MMTR / B-E2E.** |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | R-MWCL-1 shipped; 3..7 residual. **B-MONITOR.** |
| 32 | R-TFP | `test:fast` + `test:integration` parallel-load flakes — **B-PIPE-HARDEN-2** (Class C: serialize auto-resume-stop-conditions + microverse, both isolation-clean but flake at c=8 during 2026-05-27 B-PIPE-BABYSIT-HARDEN gate). | `p2-test-fast-stability-gate-widening-2026-05-19.md`. v1.76.0 serialized the subprocess-heavy tail via `.serial-tests.json` and retiered `council-publish` / `mux-runner.output-stall` / `check-update` fast→integration — gate verified green. B-FLAKE SHIPPED; watch item only. |
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

### Closed since last update (2026-05-29)
- #88 R-CWRR — **B-CWRR v1.82.1.** Citadel treated `workingDir` as `repoRoot`, doubling the package segment (`<repo>/packages/api/packages/api/...` → ENOENT) on monorepo subpackage sessions. F3 fix: **Class A** (`cd139d23`) added `PipelineRuntime.repoRoot` distinct from `workingDir` — computed once in `loadPipelineRuntime` via `git -C workingDir rev-parse --show-toplevel` (fallback to `workingDir` on non-repo) — and repointed `executeCitadelPhase` at `runtime.repoRoot`, with the AC-CWRR-4 regression spec `citadel-reporoot-monorepo.test.js` proving the monorepo + single-package cases. **Class B** (`cf9808e9`) swept `pipeline-runner.ts`, converting 5 toplevel-intent `workingDir` sites to `repoRoot` and annotating the shell-cwd-intent remainder with `// why workingDir, not repoRoot`. **Class C** (`b9b00df2`) fixed the fatal-exit `pipeline-status.json` write so `completed_phases`/`total_phases` carry forward prior-phase tallies instead of zeroing. Schema-neutral (AC-CWRR-06 — `repoRoot` is in-memory runtime, no `state.json` field, no `LATEST_SCHEMA_VERSION` bump). Test-fixture alignment `b5ff5f99`. Closer `10b787c9` (full release gate green — fast 5192/integration 725/expensive incl. self-skipping soak — + PATCH bump). No new trap door: the AC-CWRR-4 regression spec + the mandated `// why workingDir, not repoRoot` annotations already guard the conflation. PRD: `prds/p1-bug-fix-bundle-b-cwrr-citadel-workingdir-as-reporoot-2026-05-29.md`.

### Closed since last update (2026-05-27)
- #80 R-OMS + #81 R-AISLOW + #82 R-SJLAG — **B-PIPE-BABYSIT-HARDEN v1.81.0.** Long-running-pipeline health, all 3 surfaced by the B-RELEASE-DRIFT babysit. **R-AISLOW** `findFirstPendingTicket` iteration-start pre-skip (`a03b1766`) — already-Done top ticket advances without a claude turn (~1h→sub-second). **R-OMS** orphan-manager reaping via sidecar `.active_manager.pid` + ps-scan, emits `orphan_manager_reaped` (`ed13a2a5`, operator-salvaged after the worker timed out post-implement — tsc+15/15 validated). **R-SJLAG** manager-turn freshness heartbeat, bumps state.json mtime + emits `manager_turn_progress` (`24cb85d0`+`94cb35c0`). Schema-neutral (no `LATEST_SCHEMA_VERSION` bump — dodges #74 R-WSWA). Closer `8978b306` (v1.81.0). PRD: `prds/p1-bug-fix-bundle-b-pipe-babysit-harden-2026-05-27.md`. Run incidents: b04f41d6 hit #34 R-WTB worker-timeout-too-short (salvaged); in-pipeline closer looped on deploy-lifecycle-soak run in isolation (operator took over closer manually). Gate authoritatively green — only-ever-red was 2 R-TFP #32 concurrency flakes (auto-resume-stop-conditions, microverse), triple-confirmed non-real (isolation + c=4 + out-of-scope).
- #79 B-RELEASE-DRIFT — **v1.80.2.** All 5 root-cause classes of the 12 release-gate test failures resolved: (a) R-SMTEST spawn-morty fast-fail wedge ×5 (early-exit guard for `--ticket-path` outside data root), (b) R-MUXQG quality-gate skip warn-once test pollution ×2 (`_resetQualityGateSkipDeprecation`), (c) R-MUXAUDIT ticket-audit-halt assertion drift + slow spawn, (d) R-EMWMOCK ensureMonitorWindow injected-spawn capture drift, (e) R-RSFISO resolveStateFile test isolation. Plus 2 in-flight drift discoveries: R-SMTEST-6 EVENT_NAMES registration `827c6641`, R-RELDRIFT-2 HT-1 annotation + audit-bypass test isolation `b2c286a2`. 13 tickets. PRD: `prds/p1-bug-fix-bundle-b-release-drift-2026-05-26.md`. Closer `957e3087`. Babysitter salvages during run: 2× R-WSRC reset recovery (path-scoped `git restore --source`), 1× `allow_inferred_completion_commit` bypass (→ filed #83).
- #83 R-RIC-EXPLICIT — **v1.80.3.** `hasCompletionCommit` now honors explicit `completion_commit:` frontmatter in `<sessionDir>/<ticketId>/linear_ticket_<ticketId>.md`, preventing the mid-bundle `[fatal] cannot flip Done … source==='inferred'` brick after a manager kill. R-RIC-EXPLICIT-1 red test `3255dec5`, R-RIC-EXPLICIT-2 fix (decouple gitCommitExists from explicit-frontmatter branch) `6efc4e53`, R-RIC-EXPLICIT-4 phantom-revert watcher reachability (regression the release gate caught + closer fixed) `103ef20b`, bump + trap-door `863016bb`. Trap door R-RIC-EXPLICIT in `services/CLAUDE.md`; ENFORCE `extension/tests/has-completion-commit-explicit-source.test.js`. PRD: `prds/p1-bug-fix-bundle-b-ric-explicit-2026-05-27.md`. Tag `b451e657`. Full release gate verified green (0 failures across fast/integration/expensive).

Earlier closed (detail in archive): #1-#4 (incl. R-CCPL reopened-P1 closed 2026-05-15 by R-CCPM-1..5 — `f915b821`/`690e5c5c`/`e955ce4d`/`39a660e4`/`73657d27`), #6, #8-#10, #13-#17, #20-#24, #26, #31, #36-#38, #41-#45 R-WSRC/R-MRWG/R-CTSF/R-CCPM-1b.

---

## Active Queue — bug bundles first

≤14 tickets/bundle. Status: NEXT · IN-FLIGHT · QUEUED · DEFERRED · SHIPPED. NEXT bundles listed in dispatch order (reordered 2026-05-24).

### P1 bundles — dispatch order

| # | Bundle | Status | Composes | Notes |
|---|---|---|---|---|
| — | **B-PIPE-BABYSIT-HARDEN** | SHIPPED | #80 R-OMS + #81 R-AISLOW + #82 R-SJLAG | **CLOSED v1.81.0** — bundle PRD `p1-bug-fix-bundle-b-pipe-babysit-harden-2026-05-27.md`. Refined to 4 tickets: R-AISLOW pre-skip (`a03b1766`), R-OMS reaping (`ed13a2a5`), R-SJLAG heartbeat (`24cb85d0`+`94cb35c0`), closer (`8978b306`). Schema-neutral. Closes #80/#81/#82. Run incidents → follow-ups: #34 R-WTB (worker timeout too short, b04f41d6 salvaged), closer-soak-in-isolation loop, #32 R-TFP flakes (auto-resume/microverse, isolation-clean). |
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
| **B-PIPE-HARDEN-2** | **NEXT** | #34 R-WTB + #87 R-CSIS + #32 R-TFP | bundle PRD `p2-bug-fix-bundle-b-pipe-harden-2-2026-05-28.md`. ~7-8 tickets, drains the 3 operator-salvage burdens from the B-PIPE-BABYSIT-HARDEN v1.81.0 run. A R-WTB worker-timeout floor + artifact-progress guard; B R-CSIS closer mandates `npm run test:expensive` not standalone `node --test`; C R-TFP serialize the two flaky subprocess-heavy tests. Closer bumps **v1.81.1** (PATCH — fixes only). Schema-neutral. |
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
| **R-DC** | P2 | `p2-death-crystal-architectural-deepening-skill-2026-05-28.md` | `/death-crystal` skill — vendors mattpocock/skills:improve-codebase-architecture. Two modes: `--deepen` (shallow-module HTML report) + `--interface <module>` (4-Morty "Design It Twice" parallel synthesis). Adds `## Architectural Vocabulary` pin (Module/Interface/Depth/Seam/Adapter/Leverage/Locality) to `extension/CLAUDE.md`. 11 ACs / 8 P1-tickets + closer (schema-neutral, 1.81.x → 1.82.0 MINOR). Optional Phase 2 `/jerryboree` (Clairvoyance cherry-picks) + Phase 3 `/cromulons` (Feathers safety net). |

**Order when bug queue allows:** R-PGI first (infrastructure R-PIAP-A5 consumes), then R-PIAP, then R-DC.

### Deferred future epics

- **Integrations:** `hermes-integration.md` (P2 ready), `deepseek-integration.md` (P3 draft), `openrouter-multi-provider-workers.md` (P3)
- **Refactor:** `god-functions-remediation-phase-2.md` (27 carve-outs)
- **Methodology PRDs:** `portal-gun.md`, `pickle-debate.md`, `pickle-microverse.md`
- **Design docs (no ship target):** `citadel.md`, `pickle-dot-codegen-builder.md`, `council-of-ricks-catalog-mode-and-publish-fixes.md`, `plumbus-generative-audit-frames.md`, `pickle-agent-teams.md`, `smart-iteration-handoff.md`, `tool-error-retry-tracking.md`

---

## Recently Shipped

| Release | Date | Content |
|---|---|---|
| v1.82.1 | 2026-05-29 | **B-CWRR CLOSED** (#88, session `2026-05-29-58a9de87`) — citadel monorepo `workingDir`-as-`repoRoot` package-segment doubling. Class A `PipelineRuntime.repoRoot` + `executeCitadelPhase` repoint + AC-CWRR-4 regression spec (`cd139d23`), Class B 5-site call-site audit + annotations (`cf9808e9`), Class C pipeline-status fatal-exit counter carry-forward (`b9b00df2`), test-fixture alignment (`b5ff5f99`), closer release-gate green + PATCH bump (`10b787c9`). Schema-neutral (AC-CWRR-06). |
| v1.82.0 | 2026-05-29 | **B-AFCC-DEEP CLOSED** (12/12, session `pickle-a9e25752`) — autofill / Done-flip cluster RCA bundle. Created `TicketCompletionEvidence` module + 5 callsite migration (`fadc2477`), collapsed `auto-fill-completion-commit` (`8b0e741a`) + `inspectPhantomDoneTicketFile`/`correctPhantomDoneTickets` (`d235d24d`) into thin shims, pushed `git cat-file -e` reachability into `hasCompletionCommit` (`434774fc`), 8-path characterization suite (`3de26d83` + `db992304`), R-CLOSER-ADJACENCY-AUDIT 6-step template (`ab432842`) + audit-trap-door-enforcement wiring (`dfbd252d`), 3 new trap doors + R-AFCC-DEEP-CONSOLIDATED master pin (`219a5e63`), closer release-gate green + v1.82.0 + masked-failure remediation (`0e64a705`). |
| v1.81.1 | 2026-05-28 | **B-PIPE-HARDEN-2 CLOSED** (session `pickle-dfb58722`) — 9/9 tickets including hardening on R-TFP-C1/C2/C3 (test:fast c=8 flake serialization + audit-subprocess-heavy-tests forward-protection + 3× regression loop). Closer `c7feae53` synced release-gate parity fixture + lockfile (`6dc6a987`); residual sync (`2052107b`) caught remaining drift in `release-gate-parity.test.js` + outer `CLAUDE.md` gate prose + `activity-logger.test.js` expected list (missing R-WTB-A1 events) + `audit-subprocess-heavy-tests.test.js` integration+serial promotion (self-flake at c=8). |
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
