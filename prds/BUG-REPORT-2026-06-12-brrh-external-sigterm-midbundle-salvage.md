# Bug Report — B-RRH external SIGTERM mid-bundle kill + manual salvage (2026-06-12)

**Session:** `2026-06-10-...`? NO — `2026-06-12-8f02855b` (B-RRH, v2.0.0-beta.2/3 bundle).
**Class:** recurrence of B-XSPA (external SIGTERM mid-bundle) — row 36, consolidated into B-RRH.
**Severity:** P2 (residual gap; the dangerous half was already fixed).

## What happened

At `2026-06-12T21:49:06Z` an **external** signal (`signal_received` activity event; not operator-issued, the recurring environmental SIGTERM/SIGINT class) killed the mux-runner (pid 76997) mid-bundle, **after E9b (`612217e2`) landed**. State froze at `active=false`, `step=completed`, `exit_reason=failed`, iter 17. All **16 implementation tickets were Done and committed on HEAD** (`b980e0fc`); only the **4 hardening tickets (71001154/ed840487/5495bee2/1cf82fe7) + closer (00fa0662)** remained Todo.

Two **verified-green** uncommitted edits were stranded in the working tree (a worker WIP when the signal hit):
- `extension/tests/rrh-forward-ref-coverage.test.js` — relaxed an over-strict `contract`-finding assertion to match actual R-FRA-6 resolver behavior (path teeth preserved; 7/7 green).
- `extension/CLAUDE.md` — documented the `rate_limit_park` INVARIANT (Workstream B / e9bdac75).

## What worked (positive signal)

The deployed **C1/C2 phase-gate fix (beta.2)** did its job: the runner did **NOT** prematurely advance pickle→citadel on the partial build. `pipeline-status.json` showed `completed_phases:1` from the signal teardown, but the main phase loop (`pipeline-runner.ts:3519`) re-evaluates ticket statuses on relaunch and has no `completed_phases`-based skip — so it correctly re-entered PHASE 1 PICKLE.

## Residual gap (the actual bug)

This interactive tmux session had **no auto-resume wrapper armed**, so an external signal requires **manual babysitter salvage**: commit verified work reset-proof → reset `step=research`/clear `exit_reason` → kill stale tmux → relaunch. The recurring environmental signal will keep costing a manual intervention per occurrence until either (a) the session is launched under `auto-resume.sh` (R-CNAR foreground wrapper), or (b) the environmental signal source is identified and removed.

## Recovery applied (babysitter, this session)

1. Verified all 16 impl tickets Done + committed on HEAD; orphan scan clean (no Failed-flip orphans).
2. Ran the affected test → 7/7 green; committed the 2 salvaged edits reset-proof as `97065d0e` (`fix(b-rrh): salvage interrupted test-correctness + rate_limit_park invariant doc`).
3. Reset `step=research`, `current_ticket=null`, cleared `exit_reason` via node StateManager (R-WSRC hook can't see inside node).
4. Killed stale tmux, relaunched via `launch.sh`. Runner re-entered PHASE 1 PICKLE, claimed lowest Todo `71001154`, new pid 27162 with live worker 27988.

## Proposed ACs (if promoted to a bundle)

- **R-XSIG-1:** when a B-RRH-class long bundle is launched in interactive tmux, document (or default) the `auto-resume.sh` wrapper so an external signal auto-recovers without manual salvage.
- **R-XSIG-2:** identify the recurring environmental SIGTERM/SIGINT source (cron? IDE? OS power event?) — file separately if reproducible.

Escalate to P1 only on a third manual-salvage recurrence in one bundle.

---

## ADDENDUM 2026-06-12 23:00Z — R-XSPA-2: signal-shutdown exit-0 DEFEATS the C1/C2 incomplete-bundle guard (PREMATURE ADVANCE, P1)

A **third** external signal (`signal_received` 22:52:37.955Z) hit the pickle mux-runner. This time the consequence was worse than a clean kill — the pipeline **prematurely advanced two phases on an incomplete bundle**:

```
signal_received                      22:52:37.955Z
Phase pickle exited with code 0      22:52:37.971Z   ← signal handler exits 0
Phase pickle completed successfully                  ← pipeline-runner advances
PHASE 2/4: CITADEL → PHASE 3/4: ANATOMY-PARK
```

At advance time only **16/21** tickets were Done (71001154 In Progress, 5495bee2/1cf82fe7/ed840487/closer 00fa0662 Todo). anatomy-park (microverse-runner pid 42992) ran on an incomplete bundle; the **closer never executed and nothing shipped**.

### Root cause (the C1/C2 gap)

The deployed C1/C2 / R-ICP-2 / R-PHC-6 incomplete-bundle guard fires on a **non-zero** pickle exit (`PipelineRunnerExitCode.PhaseIncomplete = 3`). But the mux-runner **signal-shutdown handler exits 0** (graceful). So a SIGTERM during pickle with pending tickets produces a clean exit-0 that `pipeline-runner` reads as "Phase pickle completed successfully" → advances. The guard never sees a non-zero code. This is the residual half of B-XSPA that the beta.2 fix did **not** close.

### Proposed AC (P1)

- **R-XSPA-2:** the mux-runner signal-shutdown path MUST, when pending (Todo/In-Progress) tickets remain in the bundle, exit with `PipelineRunnerExitCode.PhaseIncomplete (3)` (or stamp `exit_reason='pipeline_phase_incomplete'` that `pipeline-runner` honors) instead of exit 0 — so the incomplete-bundle guard fires and the pipeline does NOT advance pickle→citadel on a signal-truncated build. ENFORCE: an integration test that SIGTERMs the pickle mux-runner mid-bundle and asserts pipeline-runner does NOT enter citadel/anatomy-park.

### Recovery applied (2nd salvage this bundle)

1. Froze the whole session tree (2 pipeline-runners 27054/14425, 2 microverse-runners 42992/46183, worker) — killed.
2. Reconciled: 71001154 work is committed reset-proof (`1b2697d3` + 6 lines swept into anatomy auto-commit `9a1ccf9a`); tree clean; no orphans.
3. Kept 71001154 In Progress (full research+plan+impl artifacts present → resume, not restart); reset `step=research`/`current_ticket=null`/cleared `exit_reason`; killed stale tmux; relaunched.
4. Runner re-entered PHASE 1 PICKLE (pid 53498, worker 53945), resumed 71001154 at `step=implement`.

**Escalating R-XSIG/R-XSPA-2 to P1** — this is the 2nd manual salvage in one bundle AND it exposed a premature-advance code gap, not just a missing wrapper.
