---
title: BUG REPORT — 2026-06-05 — the mux-runner no-progress detector fails a ticket `oversized_no_progress` and hands off terminal even when the worker has ALREADY produced complete, gate-passing output in the working tree — it just never reached its commit step; the completed+verified work is discarded (and blown away by the next clean-tree relaunch) instead of being committed and the ticket marked Done.
status: Draft
filed: 2026-06-05
priority: P2
type: bug-incident
r_code: R-WCUC
bundle: B-GNXR
related:
  - prds/MASTER_PLAN.md                                                          # finding #99 (R-WCUC); Drain Queue row 27 (B-GNXR, ticket R-WCUC-10)
  - prds/BUG-REPORT-2026-06-04-pipeline-launch-gitnexus-statdrift-dirty-tree-abort.md  # R-PRNF (#98) — adjacent run-integrity class (runner mis-handles a non-green pickle exit); same LOA-907 incident
  - extension/src/bin/mux-runner.ts                                              # no-progress detector + oversized_no_progress + closer_handoff_terminal
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-06-04-0204150f  # LOA-907 appraisal→LangGraph build (codex). Ticket 907.1 (f3f27767) — primary repro.
---

# R-WCUC — no-progress detector discards completed, gate-passing-but-uncommitted worker output instead of committing it

## Status

**Open.** Directly observed 2026-06-05 (LOA-907 build, codex). The completed work was recovered manually (babysitter verified + committed); pickle-rick itself discarded it. P2 — escalates toward work-loss (P1) because the next launch's clean-tree precondition would blow the uncommitted work away if nothing rescues it.

## TL;DR

The mux-runner's no-progress detector flags a ticket `oversized_no_progress` (→ `closer_handoff_terminal`, pipeline pauses) when no **commit** lands across 2 consecutive iterations. But a worker can fully COMPLETE a ticket — write all the files, pass typecheck AND the ticket's own acceptance spec — and simply never reach its commit step within the iteration/timeout budget (slow commit phase, implement↔review cycling, or timeout before commit). The detector keys on *commits landed*, not on *working-tree changes that pass the ticket's gates*, so it marks the ticket **Failed** and hands off terminal — **discarding completed, verified work**. The work sits uncommitted in the tree and is then wiped by the next launch's mandatory clean-tree restore.

A human/babysitter had to manually `git restore`-protect, verify (typecheck + spec), and commit the worker's output to salvage it and advance.

## Evidence (session 2026-06-04-0204150f, ticket 907.1 / f3f27767)

- `state.json`: `failure_reason: "oversized_no_progress"`, `reason: "ticket f3f27767 remained Failed on HEAD 7ed8c4085... for 2/2 consecutive iterations"`, `terminal_exit_reason: "closer_handoff_terminal"`; `pipeline-runner.log`: `Phase pickle stopped for manager handoff ... paused for operator/closer work` after 58m.
- BUT the worker had produced the **entire** deliverable, uncommitted, in the working tree:
  - `?? packages/api/src/langgraph/agents/appraisalEvaluation/` — `buildAppraisalEvaluationGraph.ts`, `state.ts`, `CLAUDE.md`, `buildAppraisalEvaluationGraph.spec.ts`, and all **14** `nodes/*/` dirs.
  - `M packages/api/src/langgraph/langgraph.service.ts`, `M .../utils/langsmith-anonymizer.ts`.
- The output PASSED its gates: `pnpm typecheck` clean; `buildAppraisalEvaluationGraph.spec.ts` → 4/4 passed (14 node IDs pinned, conditional edges + ATTOM back-edge, no-binary-channels-in-state, options-object factory). i.e. the ticket's acceptance criteria were objectively met — it was Done in everything but the commit.
- pickle-rick marked it **Failed** and paused. The babysitter recovered it manually: verified the gates, committed the scaffold (`1ecd3b915`), marked the ticket Done, advanced to the next ticket. Pickle-rick contributed nothing to the recovery.

## Mechanism

1. The pickle worker lifecycle is research → review → plan → review → implement → spec-conformance → code-review → simplify → **commit**. The no-progress detector measures progress as *new commits between iterations*.
2. A worker that does all the work but cycles in implement↔review (or is killed by the worker-timeout before the commit phase) lands **zero commits** even though the working tree now contains complete, gate-passing changes.
3. After 2 such iterations the detector fires `oversized_no_progress` → `closer_handoff_terminal` → pipeline pause. The completed diff is never committed.
4. Because every relaunch requires a clean tree (and restores/discards uncommitted changes), the work is **lost** unless a human/babysitter intervenes first.

This is adjacent to **R-PRNF (#98)** — both are the runner/mux-runner mishandling a non-green pickle outcome — but distinct: R-PRNF is the *runner* laundering a zero-work halt into a false "continue"; R-WCUC is the *no-progress detector* discarding **real, completed, verified** work as a failure.

## Proposed fixes (machine-checkable ACs — confirm with a regression first)

- **AC-R-WCUC-1:** before declaring `oversized_no_progress`/Failed, the detector must inspect the working tree for uncommitted changes attributable to the ticket; if present AND the ticket's gate (typecheck + its acceptance spec(s)) passes, **commit the worker output and mark the ticket Done** instead of Failed. Verify: a regression where a worker writes gate-passing files but never commits → the ticket ends `Done` with a commit, not `Failed`.
- **AC-R-WCUC-2:** if uncommitted changes are present but gates FAIL, do NOT silently discard them on the next clean-tree relaunch — record the diff (stash ref / patch file in the session dir) in the failure record. Verify: the failed-ticket record references the preserved diff; relaunch does not destroy it unrecorded.
- **AC-R-WCUC-3:** split the `failure_reason` taxonomy so `no_work_produced` (true no-progress) is distinct from `work_uncommitted` (tree has gate-passing changes). Verify: the 907.1-shaped case reports `work_uncommitted`, not `oversized_no_progress`, so downstream recovery chooses commit-vs-split correctly.

## NOT in scope

The worker lifecycle itself (why the commit step didn't fire — could be timeout or implement↔review cycling; a separate investigation). True oversized tickets that produce no convergent work (those correctly fail/split — see 907.0 in the same session, which produced no files and was correctly split). The R-PRNF runner-continue defect (#98).
