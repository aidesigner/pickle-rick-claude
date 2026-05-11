---
title: P1 — Bug-fix bundle 2026-05-11 — pipeline-reliability quintet (R-MMTR + R-SOA + R-PTG + R-PHC + R-APMW)
status: Draft
filed: 2026-05-11
priority: P1 (4 × P1 + 1 × P3; closer ships v1.74.0)
type: bug-bundle
composes:
  - prds/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md             # Section B — Open Finding #19 (P1)
  - prds/p3-pipeline-runner-sigint-no-origin-attribution.md                   # Section C — Open Finding #20 (P3)
  - prds/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md        # Section D — Open Finding #21 (P1)
  - prds/p1-pipeline-runner-halts-on-pickle-fail-blocks-remediation-phases.md # Section E — Open Finding #22 (P1)
  - prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md           # Section F — Open Finding #23 (P1)
related:
  - prds/p1-bug-fix-bundle-2026-05-10.md     # predecessor — shipped 34/37 sections, R-CLOSER-2 release gate FAILED at 53 test:fast failures; 0/4 phases completed because of #22 R-PHC
  - prds/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md   # follow-on — bundle-gated on THIS bundle landing first
  - prds/MASTER_PLAN.md   # bookkeeping target
backend_constraint: codex
refine: true
unattended: true
remediation_phases_required: ["citadel", "anatomy-park", "szechuan-sauce"]
---

# PRD — Bug-Fix Bundle 2026-05-11 — Pipeline Reliability Quintet

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

Bundle 2026-05-10 (session `2026-05-10-84ad0873`) shipped 60 commits across pickle phase but terminated at `2026-05-11T08:51:39Z` after 445m without ever running citadel, anatomy-park, or szechuan-sauce. The 0/4-phases outcome surfaced **five distinct pipeline-reliability gaps** during the session — each one independently a P1, all five together a complete loss of the "automation runs end-to-end without operator intervention" guarantee. This bundle closes all five in one shipping cycle.

### The five gaps observed in one session

1. **Finding #19 R-MMTR (P1)** — `mux-runner.ts:3725` misclassifies the claude manager `--max-turns 400` clean exit as `Subprocess error`; pickle phase tears down after 4h of work with no relaunch path. Codex backend has `evaluateCodexManagerRelaunch`; claude has nothing. Fired **twice** today on this single bundle (14:16 + 20:10 local), losing 16 ticket-hours combined; manual `bash launch.sh` recovery worked but bundle should never have stopped.

2. **Finding #20 R-SOA (P3)** — `handleShutdown(signal)` in `pipeline-runner.ts:1597-1612` logs only the bare signal name. Third pipeline death of the day (`2026-05-11T01:22:58Z` after only 6 min runtime, NOT R-MMTR) was unattributable; operator burned ~45 min triaging the SIGINT origin without breadcrumbs (TTY Ctrl-C vs external kill vs sibling-process signal indistinguishable from logs).

3. **Finding #21 R-PTG (P1)** — Per-ticket Morty worker gate at `spawn-morty.ts:613-690` (`runLintGate`) runs **only** `eslint --max-warnings=-1` + `tsc --noEmit`; no `npm run test:fast`. No between-ticket gate in `mux-runner.ts`. The closer release gate is the FIRST and ONLY point where the full `test:fast` tier runs. Bundle 2026-05-10's R-CLOSER-2 caught **53 unique failing tests** across 8 root-cause classes — every one of them invisible at ticket-time because workers don't run tests. Hardening section fixed 6; 47 residuals remain. Without R-PTG, every multi-ticket bundle accumulates the same shape of cross-ticket regressions.

4. **Finding #22 R-PHC (P1)** — `shouldHaltAfterPhase` at `pipeline-runner.ts:1356-1369` returns `true` on any non-zero pickle/anatomy/szechuan exit. Only citadel has a severity-threshold escape hatch. Defeats the central automation guarantee: anatomy-park and szechuan-sauce are convergent-remediation engines that exist exactly to clean up test/lint/conformance regressions, but they never run when pickle's closer-gate fails. Bundle 2026-05-10 lost 100% of remediation work it could have done in citadel/anatomy/szechuan.

5. **Finding #23 R-APMW (P1)** — `microverse-runner.ts:2580-2624` `handleIterationOutcome` routes a 4h `MAX_ITERATION_SECONDS` hang-guard timeout through `handleManagerErrorOutcome` → `evaluateCodexManagerRelaunch`, which returns early with `no_pending` when there are no tickets (anatomy-park has subsystems, not tickets). Result: a single slow iteration in worker-convergence mode silently kills the entire multi-hour loop. Session `2026-05-10-6ed7182b` lost iteration 111 of 200 after 19h25m wall clock with 86 trap-door commits + 101 cataloged findings already shipped — none rolled back, but the loop unrecoverable without manual relaunch and full re-warmup.

### Theme

"Keep the pipeline running and the operator informed." All five fixes share the same shape: detect a recoverable boundary signal (cap, timeout, gate-fail, slow iter), preserve work-in-progress, route to the right remediation path, never silently abort. Together they upgrade the pipeline from "halts on first surprise" to "remediates and continues, only halts on truly unrecoverable state corruption."

## Backend constraint

`backend_constraint: codex`. Operator preference for this bundle (post-incident from claude-backend R-MMTR firing). Codex backend has its own subprocess characteristics: longer-tail latency in worker-convergence mode, which is exactly what R-APMW (Section F) hardens against. Running THIS bundle on codex provides an in-flight stress test for R-APMW's new `WORKER_CONSECUTIVE_ERROR_CAP` logic.

## Refinement: ENABLED

`refine: true`. The 5 source PRDs together declare **47 R-codes**:
- R-MMTR-1..7 (manager max-turns)
- R-SOA-1..6 (SIGINT attribution)
- R-PTG-1..10 (per-ticket test gate)
- R-PHC-1..10 (continue-on-phase-fail)
- R-APMW-1..9 (anatomy-park subprocess error)
- Plus bundle-level R-codes for bootstrap + closer

Expected output after refinement: ~50-55 atomic tickets. R-PTG alone touches `spawn-morty.ts`, `mux-runner.ts`, `types/index.ts`, `pickle_settings.json`, and ≥3 test files — atomic decomposition prevents the single-mega-ticket failure mode.

## Per-section disposition table — R-BUNDLE-DISPO-2026-05-11

| Section | Source PRD | R-codes | Severity | Disposition | Notes |
|---|---|---|---|---|---|
| **A** | (bundle bootstrap) | A-01, A-02, A-03 | — | IMPLEMENT | `scope.json` + `pipeline.json` + pre-flight (measures current 47 test:fast residual; treats as known-baseline). Standard 3-ticket bootstrap. |
| **B** | `prds/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md` | R-MMTR-1..7 | P1 (pipeline-killer for ≥10-ticket claude phases) | IMPLEMENT | `detectManagerMaxTurnsExit` helper; generalize `evaluateCodexManagerRelaunch` → `evaluateManagerRelaunch`; drop the `state.backend === 'codex'` gate; add `CLAUDE_MANAGER_RELAUNCH_CAP=20`; wire claude max-turns into the mux-runner error branch; `manager_max_turns_relaunch` activity event; trap-door pin; E2E regression (`--max-turns 5` over 20 tickets); closer. |
| **C** | `prds/p3-pipeline-runner-sigint-no-origin-attribution.md` | R-SOA-1..6 | P3 (observability) | IMPLEMENT | Structured `signal_received` event with `pid/ppid/is_tty/pgid/active_child/current_phase/handler_stack`; specific signal name in `exit_reason` (`signal:SIGINT` vs `signal:SIGTERM` vs `signal:SIGHUP`) with backward-compat migration; dual-write to `pipeline-runner.log` + activity log; regression test; trap-door pin; (R-MAY) `launch.sh` writes `launch_shell_pid: $$` breadcrumb. Atomic ~half-day; smallest section. |
| **D** | `prds/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md` | R-PTG-1..10 | P1 (architectural) | IMPLEMENT | **Critical for the follow-on remediation bundle.** Extend `runLintGate` → `runWorkerGate` to run `cd extension && npm run test:fast` after `tsc --noEmit` passes; update `extension/CLAUDE.md:31` trap-door from "lint + tsc" to "lint + tsc + test:fast"; rename + extend test (`spawn-morty-worker-gate.test.js`); `worker_test_gate_timeout_ms` setting (default 240_000ms); worker exits `Failed` (not `Done`) on test failure + `worker_gate_failed` event + manager-prompt surfacing; between-ticket gate in `mux-runner.ts` + `cross_ticket_regression_detected` event (defense in depth); Linear-comment attribution on regression; (R-MAY) tiered `worker_gate_tier` setting; closer. |
| **E** | `prds/p1-pipeline-runner-halts-on-pickle-fail-blocks-remediation-phases.md` | R-PHC-1..10 | P1 (architectural) | IMPLEMENT | Rewrite `shouldHaltAfterPhase` at `pipeline-runner.ts:1356-1369` to default-continue for non-fatal exits with a narrow fatal allowlist (`judge_cli_missing`, `session_state_corrupted`, `baseline_unmeasurable_unrecoverable`); `state.pipeline_continue_on_phase_fail` (default `true`) + `--strict-phases` CLI opt-in; `recoverable_phase_failure` activity event; distinct continue-branch log message; regression test (pickle-fail→citadel-runs, anatomy-judge-cli-missing→halt, strict-phases override); citadel report header `pickle_phase_failed: true` field; closer auto-skip-install on prior-phase non-zero; `pickle-status` reword; bundle PRD template `remediation_phases_required` field; trap-door pin. |
| **F** | `prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md` | R-APMW-1..9 | P1 (worker-convergence-killer) | IMPLEMENT | New `handleWorkerSubprocessError` path in `handleIterationOutcome` BEFORE `handleManagerErrorOutcome` — when `outcome.completion === 'error' && state.convergence_mode === 'worker'`, increment `consecutive_subprocess_errors`; bail only after `Defaults.WORKER_CONSECUTIVE_ERROR_CAP=3`; otherwise advance subsystem rotation and continue. Wire `consecutive_subprocess_errors` into `MicroverseState` (reset on success). Emit `subprocess_error` activity event with `{iteration, completion, timedOut, wallSeconds}` + write to `state.json.last_error`. Add output-progress hang detection (separate `OUTPUT_STALL_SECONDS=1800` timer; new `stallReason: 'wall_clock' \| 'output_stall'`). Operator notification on cap-exhaustion (gated by `PICKLE_NOTIFY_ON_ERROR=1`, R-MAY). |
| **G** | (bundle closer) | R-CLOSER-1..3 + wiring + hardening | — | IMPLEMENT | R-CLOSER-1 version bump (1.73.1 → 1.74.0; minor — five new behavioral guarantees). R-CLOSER-2 release gate (full 12-step canonical chain; **per Section E's R-PHC, gate failure no longer halts the pipeline**, so anatomy-park + szechuan-sauce still run; hardening section addresses any residuals from THIS bundle's diff, not the inherited 47 from bundle 2026-05-10). R-CLOSER-3 `bash install.sh` + md5-parity 5/5 + MASTER_PLAN bookkeeping (close Findings #19, #20, #21, #22, #23; bump active queue numbers). |

## Bundle-level acceptance criteria

The bundle introduces exactly **7 activity events** (canonical set, exhaustive, deterministic — no hedging): `manager_max_turns_relaunch` (R-MMTR-4, NEW), `signal_received` (R-SOA-1, NEW), `worker_gate_failed` (R-PTG-5, NEW), `cross_ticket_regression_detected` (R-PTG-6, NEW), `recoverable_phase_failure` (R-PHC-3, NEW), `subprocess_error` (R-APMW-5, NEW), `closer_gate_outcome` (R-CLOSER-2, NEW; emitted per AC-BUNDLE-09 below). These seven are the canonical set for AC-BUNDLE-02 / AC-BUNDLE-08 verification. **Out of canonical-set scope**: the R-PTG-3 rename of existing events `worker_lint_gate_passed`→`worker_gate_passed` and `worker_lint_autofix_applied`→`worker_gate_autofix_applied` is verified by R-PTG-3's own ticket-level AC (existing event keys updated in all 5 registries with backward-compat shim), NOT by AC-BUNDLE-02. Renames are not new events.

The bundle introduces **5 trap-door entries** (full set, exhaustive): `mux-runner.ts` evaluateManagerRelaunch (R-MMTR-5); `pipeline-runner.ts` handleShutdown signal_received (R-SOA-5); `extension/CLAUDE.md:31` worker gate invariant upgrade (R-PTG-2); `pipeline-runner.ts` shouldHaltAfterPhase continue-by-default (R-PHC-6); `microverse-runner.ts` handleWorkerSubprocessError (R-APMW-7).

- [ ] **AC-BUNDLE-01** — All 5 source PRDs' ACs are individually green (per-section gating). Bundle is "Done" only when 5 × per-PRD AC checklists are 100% checked.
- [ ] **AC-BUNDLE-02** — For every event E in the canonical 7-event set above, E appears in all five canonical registries: `VALID_ACTIVITY_EVENTS` array in `extension/src/types/index.ts`, schema definition map in `extension/src/types/activity-events.ts`, schema `oneOf` discriminator, `EVENT_CASES` test array in `extension/tests/activity-event-payload.test.js`, and `spawn-refinement-team`'s `ACTIVITY_EVENT_SCHEMA_SECTION` row. Test in `extension/tests/activity-event-payload.test.js` asserts `activityEventRegistry` set-equality against `VALID_ACTIVITY_EVENTS` (per Class A lesson from bundle 2026-05-10 — set-equality, NOT a hardcoded number; drive cardinality from `Object.keys(activityEventRegistry).length`). One regression-test row per event.
- [ ] **AC-BUNDLE-03** — For every trap-door entry T in the canonical 5-entry set above, T is pinned in `extension/CLAUDE.md` AND `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0 with T's ENFORCE reference matched.
- [ ] **AC-BUNDLE-04** — `extension/CLAUDE.md:31` trap-door invariant updated from "lint + tsc" to "lint + tsc + test:fast" per R-PTG-2.
- [ ] **AC-BUNDLE-05** — MASTER_PLAN Working Rule #2 updated to reflect R-PTG; Working Rule #3 (added 2026-05-11) preserved as-is (already reflects R-PHC); closer commit body lists each Open Finding closed.
- [ ] **AC-BUNDLE-06** — `pickle-status` regression test asserts the new reword ("continued to … for automated remediation") fires when prior phase exited non-zero with downstream phases queued.
- [ ] **AC-BUNDLE-07** — `state.pipeline_continue_on_phase_fail` defaults to `true` for new sessions; existing state files without the field default to `true` on read (per R-PHC-2 schema migration).
- [ ] **AC-BUNDLE-08** — For every event E in the canonical 7-event set, the bundle's E2E fixture pipeline exercises E's triggering condition and asserts E appears in `state.json.activity` with all required payload fields per E's schema definition. One fixture per event (7 fixtures total); each fixture lives as a standalone test file in the existing `extension/tests/integration/` directory (no new subdirectory required), with naming pattern `bundle-2026-05-11-event-<event_name>.test.js`.
- [ ] **AC-BUNDLE-09** — For every closer-time gate outcome G ∈ {`passed`, `expected_residual_only_with_baseline_match`, `new_regression_introduced`, `infrastructure_failure`}, the closer MUST: (a) record `state.exit_reason` to a name uniquely identifying G; (b) execute R-CLOSER-3 (install.sh + version tag) iff G ∈ {`passed`, `expected_residual_only_with_baseline_match`}; (c) emit a `closer_gate_outcome` activity event with `{gate_outcome: G, residual_count: N, baseline_count: M}`. The 4-state outcome→action table MUST be documented inline in the R-CLOSER-2 ticket body. Residual baseline (the inherited 47 test:fast failures from bundle 2026-05-10) is captured at R-A-03 pre-flight and read by R-CLOSER-2 to compute G; the subsequent remediation bundle (`prds/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md`) is responsible for driving residual_count to 0, NOT this bundle.

## Pre-flight checklist (R-BUNDLE-PREFLIGHT-2026-05-11)

Before the pipeline launches:

1. **Working tree clean** — only the untracked PRDs from the bundle are allowed; no in-flight worker edits. The handoff sees `git status --short` and refuses to start if anything else is modified.
2. **HEAD on `main`** — `git symbolic-ref --short HEAD` returns `main`. No feature-branch operation.
3. **47-failure baseline measured** — R-A-03 pre-flight runs `cd extension && npm run test:fast 2>&1 > preflight.log`; captures the set of failing test names as `${SESSION_ROOT}/preflight_failing_tests.json`. This baseline is the input to R-CLOSER-2's "did this bundle introduce new regressions" decision (compare post-bundle gate against pre-flight baseline).
4. **No prior pipeline session attached** — `tmux ls | grep -E '^(pipeline|monitor-aux|refine)-' | head -1` returns nothing (all sessions from bundle 2026-05-10 killed in cleanup).
5. **Backend `codex` available** — `which codex` returns a path. Per operator preference; per R-APMW Section F, this bundle's run stresses codex worker-convergence error handling.
6. **`PLUMBUS_GENERATIVE_AUDIT` not set to `"off"`** — environment kill-switch is OFF, generative audits enabled per session policy.

## Risk Register

- **R1**: This bundle modifies the same `pipeline-runner.ts`, `mux-runner.ts`, and `spawn-morty.ts` files across Sections B, D, E. Merge conflicts at worker-handoff likely if multiple R-codes touch the same line range. **Mitigation**: refinement assigns ordered ticket sequencing per file; each worker rebases on HEAD before commit.
- **R2**: R-PTG-1 (`npm run test:fast` in per-ticket gate) extends per-ticket runtime by ~30-120s. With 50+ tickets in this bundle, that's an extra ~30-100 minutes of pipeline runtime. **Mitigation**: parallelize where possible (mux-runner already serializes; that's the design). Total pipeline runtime estimate: 5-8 hours including refinement.
- **R3**: R-PHC-1 (continue-on-fail) lands mid-bundle; if R-PHC ships before R-PTG, the bundle's own pickle phase exits non-zero on residual failures but continues to citadel. **Mitigation**: ordering — R-PTG ships in Section D, R-PHC in Section E. The bundle's own pickle phase **will not** benefit from R-PHC (already running on pre-R-PHC pipeline-runner); only post-bundle work will. Acknowledged.
- **R4**: R-APMW Section F changes the codex worker-convergence code paths that THIS bundle itself runs on (since `backend_constraint: codex`). Workers spawned post-R-APMW use the new error-handling. **Mitigation**: monitor `subprocess_error` activity events during the bundle; if cap exhaustion fires before bundle completes, manual intervention. This is a known live-rewire risk; codex's slow-subprocess characteristic was a primary R-APMW trigger so testing in-flight makes sense.
- **R5**: R-CLOSER-2 release gate inherits the 47 residual test failures from bundle 2026-05-10. Per AC-BUNDLE-09, the bundle's closer logic distinguishes "introduced new" from "inherited." If this bundle adds NO new failures, R-CLOSER-2 still fails at 47 but the closer marks the gate as "expected_residual_only" and proceeds to install.sh. **Mitigation**: R-CLOSER-2 acceptance criterion is "no NEW failures introduced" not "zero failures total."

## Bundle thesis

> "The pipeline must keep working through transient subprocess errors, gate failures, manager cap-exits, and signal-driven shutdowns. Today every one of those causes a full halt; after this bundle, only true state-corruption causes a halt."

If a section's fix isn't structurally aligned with that thesis, drop it. Audit script: `bash extension/scripts/audit-bundle-thesis.sh` (already exists from prior bundles).

## Closer behavior — R-CLOSER-1..3

- **R-CLOSER-1**: bump `extension/package.json` from `1.73.1` → `1.74.0` (minor — five new behavioral guarantees, even though backward-compatible).
- **R-CLOSER-2**: run canonical release gate. Accepts pass-with-inherited-residual per AC-BUNDLE-09; only fails if NEW regressions vs. R-A-03's pre-flight baseline.
- **R-CLOSER-3**: `bash install.sh --closer-context`; verify `md5-parity 5/5`; update `prds/MASTER_PLAN.md`:
  - Close Findings #19, #20, #21, #22, #23 (move to "Shipped" archive in `prds/MASTER_PLAN-archive.md`)
  - Renumber "Next bundle" queue (current slot #14 remediation bundle becomes slot #10; older slots shift)
  - Add new "Last updated" narrative summarizing v1.74.0 release + the five-finding closure
  - Update Open Findings list (#11-13 remain open from prior list; new findings discovered during this bundle's anatomy-park / szechuan-sauce phases get appended per the standard convention).

## What this bundle does NOT do

- **NOT** remediate the 47 residual test:fast failures from bundle 2026-05-10 — that's the remediation bundle (`prds/p1-bug-fix-bundle-2026-05-11-remediation-53-failures.md`), gated on THIS bundle landing first. R-CLOSER-2 here measures the residual as a baseline; the remediation bundle clears it.
- **NOT** address Finding #18 R-FGNC (finalize-gate `.npmrc` WARN classifier). That's a different surface (gate output parser) and ships in a follow-on P2 bundle.
- **NOT** add new features or refactors beyond what the five source PRDs specify. Bundle thesis is reliability; scope creep gets caught by audit-bundle-thesis.sh.

## Triggering session (this bundle's pipeline run)

Will be assigned at launch via `/pickle-pipeline --backend codex prds/p1-bug-fix-bundle-2026-05-11-pipeline-reliability-quintet.md`. Session ID format: `2026-05-11-<8-char-hash>`. Expected duration: 5-8 hours (50+ atomic tickets at codex worker latency, plus citadel + anatomy-park + szechuan-sauce phases — anatomy-park and szechuan-sauce now run regardless of pickle exit per Working Rule #3, even on this bundle's run because the rule is operator policy, not yet a code guarantee until R-PHC ships within this bundle).
