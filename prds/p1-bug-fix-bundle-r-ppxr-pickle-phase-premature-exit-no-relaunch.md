---
title: "R-PPXR — pickle phase exits incomplete every ~35min without relaunching the manager; bundle needs a babysitter relaunch per cycle (non-autonomous)"
priority: P1
finding: PPXR
status: open
type: bug-bundle
schema_neutral: true
source_assessment: "2026-06-16 live B-GA build, session 2026-06-16-3c1831d7 — 3 consecutive pickle-phase invocations each exited pipeline_phase_incomplete after ~33-38min, each needing a babysitter relaunch"
---

# R-PPXR — Pickle phase prematurely exits incomplete, mux-runner does not relaunch the manager

## Symptom (reproducing, live)

During the B-GA build (session `2026-06-16-3c1831d7`, 12 tickets, several `large` tier), the **pickle
phase exits code 0 with tickets still pending after ~33–38 minutes, repeatedly** — three invocations so
far, each requiring a babysitter relaunch to continue:

| Run | Wall | Outcome | Done after |
|---|---|---|---|
| 1 | 33m | `de345802` left In-Progress, impl **uncommitted** in tree | 0/12 |
| 2 | 38m | `de345802` → Done (`ada1f5c0`); `28d95d77` implemented, **uncommitted** | 1/12 |
| 3 | (in progress) | `28d95d77` resuming | 1/12 |

Each run: `Phase pickle exited with code 0` → `exited clean (exit 0) but N tickets remain pending —
marking phase incomplete (not advancing)` → pipeline exits `pipeline_phase_incomplete`.

## What is NOT broken (do not touch)

- The **incomplete-guard is working correctly** (B-DSAN2 WS-A / R-PPA-1): pickle exiting with pending
  tickets does NOT falsely advance to citadel. No false ship. Keep it.
- The pipeline makes **real forward progress each run** (≈1 ticket per ~2 runs) — work is not lost when
  the babysitter preserves the uncommitted WIP and relaunches.

## Root pattern (evidence)

1. `state.manager_relaunch_count` is **never set** (undefined) across all runs → the R-MMTR-3
   (`evaluateManagerRelaunch`, `CLAUDE_MANAGER_RELAUNCH_CAP`) and R-CMWL claude max-turns relaunch path
   is **not engaging**. The mux-runner exits instead of relaunching the manager subprocess.
2. Each run's last `tmux_iteration_<n>.log` ends mid-tool-result (`type=user`), NOT a clean `result` /
   `end_turn` event → the manager (`claude -p`) appears **cut off / terminated mid-conversation**, not a
   clean turn completion. `detectManagerMaxTurnsExit` needs `num_turns` from a `result` event; absent
   it returns `false` (conservative) → no relaunch → mux exits code 0.
3. The bundle is dominated by `large`-tier tickets (AC-GA-REC-1/REC-2) whose full 8-phase lifecycle
   (research→…→simplify→commit) exceeds a single manager turn budget. iter only reached 3 in 38min;
   `max_iterations` is 500 and `max_time_minutes` is 0 (unlimited), so neither the iteration cap nor a
   wall-clock cap is the trigger — the ~33–38min consistency points at an undiagnosed manager-process
   termination.

Net: the manager exhausts its turn / is killed mid-large-ticket, mux-runner classifies the exit as
non-relaunchable, and the whole pipeline terminates `pipeline_phase_incomplete` — requiring an external
relaunch. On a 12-ticket bundle that is ~10+ babysitter relaunches = **not autonomous**.

## Acceptance Criteria (candidate fixes — refinement to select)

- [ ] **AC-PPXR-1 — pickle phase auto-relaunches on incomplete-with-progress.** When the pickle phase
  exits `pipeline_phase_incomplete` AND the Done count increased since the phase's previous invocation
  (genuine progress), `pipeline-runner` MUST re-enter the pickle phase (bounded by a no-progress cap —
  e.g. K consecutive incomplete exits with zero new Done → halt) instead of terminating the pipeline.
  This is the inverse of the R-PPA-1 guard: R-PPA-1 stops a FALSE advance; this resumes a TRUE-but-
  incomplete phase. — Type: test
- [ ] **AC-PPXR-2 — classify the cut-off-manager exit as relaunchable.** Diagnose why the manager
  `claude -p` ends mid-tool-result at ~33–38min (undocumented timeout? SIGTERM source? max-turns
  without a result event?). If it is a turn/length termination, `classifyManagerRelaunchExit` /
  `detectManagerMaxTurnsExit` MUST treat a cut-off (no `result` event) manager exit with pending
  tickets as relaunchable up to `CLAUDE_MANAGER_RELAUNCH_CAP`, so mux-runner relaunches in-process
  rather than exiting. — Type: test + root-cause
- [ ] **AC-PPXR-3 — interim mitigation: launch under `auto-resume.sh`.** Document + default that full
  pipelines launch wrapped in `extension/scripts/auto-resume.sh`, whose R-CNAR-4(c) stop-condition
  already keys on `exit_reason !== 'pipeline_phase_incomplete'` — i.e. it AUTO-relaunches on
  `pipeline_phase_incomplete` up to `PICKLE_AUTO_RESUME_MAX_RETRIES` (10) / max-wall. This converts the
  babysitter relaunch treadmill into the existing automatic mechanism with ZERO new code — a pure reuse
  (subtract-before-add). Verify it drives a multi-incomplete-exit bundle to completion unattended. —
  Type: test
- [ ] **AC-PPXR-4 — typecheck + lint + compiled-mirror parity.** — Type: typecheck

## Simplification Review (subtract-before-add)

- **AC-PPXR-3 is pure REUSE** — `auto-resume.sh` already implements exactly the auto-relaunch-on-
  incomplete loop; the bug is that pipelines aren't launched through it. Prefer this over building any
  new relaunch machinery in pipeline-runner. **This is likely the whole fix.**
- **AC-PPXR-1** only adds code if AC-PPXR-3 (the wrapper) proves insufficient — e.g. if in-process
  re-entry is needed for state continuity the wrapper can't provide. Challenge before building.
- **AC-PPXR-2** is diagnosis-first: do not add a relaunch branch until the manager-termination cause is
  understood (it may be a fixable timeout misconfiguration, not a missing branch).
- Relationship to B-GA's own WS-2: B-GA fixes worker silent-death + large-tier worker ROUTING; R-PPXR
  is the adjacent MANAGER-turn-exhaustion-without-relaunch class. Recompose if drained together.

## Notes

Filed 2026-06-16 after the B-GA build required 3 babysitter relaunches in ~2h. Each recovery: reset-
proof commit of the uncommitted worker WIP (non-attributing message so the completion-evidence oracle
doesn't false-flip) → clear dirty-tree block → relaunch. Recovery commits `8e9987c2`, `02df7531`.
Per `feedback_loop_failure_log_bug_prd_and_master_plan`: logged as drainable work, not silent
firefighting.
